"""Optionally expose the standalone Prospect MCP (mcp/prospect_mcp.py) as a mountable
Streamable-HTTP ASGI app, so hosted users can add Prospect's analytics tools to their own
Claude client (Desktop / Code / claude.ai custom connector).

The module is loaded BY FILE PATH rather than imported, to dodge the name clash between the
repo's local `mcp/` directory and the installed `mcp` SDK package (which prospect_mcp.py
itself imports as `mcp.server.fastmcp`). Loading it under a distinct module name keeps that
`import mcp...` resolving to site-packages.

Fully optional and defensive: if disabled, the file is missing, the SDK isn't installed, or
the marts aren't present, this returns (None, None) and the API runs exactly as before.
"""
from __future__ import annotations

import importlib.util
from typing import Any

from .config import REPO_ROOT, settings

# The loaded prospect_mcp module (None until load_prospect_mcp succeeds). Kept so the
# app's shutdown path can close the module's own DuckDB connection — main.py closes
# analytics_db explicitly, and without this hook the MCP's read-only conn would leak.
_loaded_module: Any | None = None

# Size cap for the JSONL tool-call log before it rolls over to a single <path>.1 archive
# (overwritten each rollover) — bounds disk use at ~2x this figure without needing a
# log-rotation daemon. Lines are capped at ~2KB (see _log_call), so 5MB is ~2.5K calls.
_MAX_LOG_BYTES = 5 * 1024 * 1024


def close_prospect_mcp() -> None:
    """Close the loaded MCP module's DuckDB connection (idempotent, best-effort).

    Called unconditionally from main.py's lifespan shutdown; a no-op when the MCP was
    never loaded, and tolerant of an older prospect_mcp.py without close().
    """
    global _loaded_module
    module, _loaded_module = _loaded_module, None
    if module is None:
        return
    try:
        module.close()
    except Exception:  # noqa: BLE001 — shutdown must never fail on cleanup
        pass


def load_prospect_mcp() -> tuple[Any | None, Any | None]:
    """Return (fastmcp_server, asgi_app) for mounting, or (None, None) if unavailable."""
    if not settings.enable_mcp:
        return None, None

    mcp_file = REPO_ROOT / "mcp" / "prospect_mcp.py"
    if not mcp_file.exists():
        print(f"[api] MCP: {mcp_file} not found; skipping /mcp mount.")
        return None, None

    try:
        spec = importlib.util.spec_from_file_location("prospect_mcp_server", str(mcp_file))
        if spec is None or spec.loader is None:
            print("[api] MCP: could not create import spec; skipping /mcp mount.")
            return None, None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)  # defines the tools; guarded __main__ won't run
        global _loaded_module
        _loaded_module = module  # conn is open from here on — track it for shutdown close

        server = module.mcp
        # Stateless: each request is independent — right for many unrelated Claude clients
        # hitting one instance. Inner route at "/" so, mounted at "/mcp", the endpoint is /mcp.
        server.settings.stateless_http = True
        server.settings.streamable_http_path = "/"
        # The SDK's DNS-rebinding guard defaults to localhost-only Host/Origin and 421s every
        # other Host — including our public DO hostname behind its proxy. Disable it: this is a
        # public, read-only, REMOTE server, and DNS rebinding is a localhost-targeting attack.
        from mcp.server.transport_security import TransportSecuritySettings
        server.settings.transport_security = TransportSecuritySettings(
            enable_dns_rebinding_protection=False,
        )
        # Per-tool usage counter (Prometheus, at the app's existing /metrics) + a content log
        # of what people actually ask (tool name + arguments as JSONL, no user identifiers —
        # the MCP transport doesn't even hand us one here). Both wrap ToolManager.call_tool —
        # the single choke point every tool invocation passes through. Best-effort throughout;
        # observability must never break the MCP.
        try:
            from prometheus_client import Counter as _Counter

            _tool_calls = _Counter("mcp_tool_calls_total", "MCP tool calls by tool name", ["tool"])
        except Exception as _exc:  # noqa: BLE001
            _tool_calls = None
            print(f"[api] MCP: per-tool metrics off ({_exc!r}).")

        _log_path = settings.mcp_call_log_path

        def _log_call(name: str, arguments: Any, ok: bool, ms: int) -> None:
            if not _log_path:
                return
            try:
                import json
                from datetime import datetime, timezone

                args_json = json.dumps(arguments, ensure_ascii=False, default=str)
                if len(args_json) > 2000:  # one hostile call can't bloat the log
                    args_json = args_json[:2000] + "…"
                line = json.dumps(
                    {
                        "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                        "tool": name,
                        "args": args_json,
                        "ok": ok,
                        "ms": ms,
                    },
                    ensure_ascii=False,
                )
                # Size-based rotation BEFORE the append: at the cap, the live file becomes
                # the single .1 archive (os.replace overwrites the previous archive) and a
                # fresh log starts — so an append-forever log can't eat the disk. Racing
                # writers are benign: at worst two rotations happen back-to-back and a few
                # lines land in the archive early.
                import os

                try:
                    if os.path.getsize(_log_path) >= _MAX_LOG_BYTES:
                        os.replace(_log_path, f"{_log_path}.1")
                except OSError:
                    pass  # first write (no file yet) or a racing worker already rotated
                with open(_log_path, "a", encoding="utf-8") as fh:
                    fh.write(line + "\n")
            except Exception:
                pass

        _orig_call = server._tool_manager.call_tool

        async def _observed_call(name, arguments, *a, **kw):
            if _tool_calls is not None:
                try:
                    _tool_calls.labels(tool=name).inc()
                except Exception:
                    pass
            import time as _time
            from functools import partial

            import anyio
            import anyio.to_thread

            t0 = _time.monotonic()
            # Every Prospect tool is a plain sync `def`, and the FastMCP SDK calls sync
            # tools INLINE on the event loop (func_metadata.call_fn_with_arg_validation:
            # `if fn_is_async: await fn(...) else: fn(...)`) — so one slow DuckDB read
            # would freeze ALL HTTP traffic on this worker. Offload the whole SDK call to
            # a worker thread: anyio.run() there spins a private event loop to drive the
            # SDK's async plumbing (arg validation + result conversion — loop-independent
            # pure computation), and the blocking DuckDB read blocks only that thread.
            # Concurrent tool calls still serialize on prospect_mcp's module-global
            # connection lock — correct, just not parallel. CONSTRAINT: this relies on no
            # tool taking a Context parameter (none does today) — Context methods talk to
            # the client session over the SERVER loop and must not be driven from the
            # worker loop.
            _bound = partial(_orig_call, name, arguments, *a, **kw)
            try:
                result = await anyio.to_thread.run_sync(lambda: anyio.run(_bound))
            except Exception:
                _log_call(name, arguments, ok=False, ms=int((_time.monotonic() - t0) * 1000))
                raise
            _log_call(name, arguments, ok=True, ms=int((_time.monotonic() - t0) * 1000))
            return result

        server._tool_manager.call_tool = _observed_call
        print(f"[api] MCP: tool-call observability on (metrics={'yes' if _tool_calls else 'no'}, log={_log_path or 'off'}); sync tools offloaded to worker threads.")
        asgi_app = server.streamable_http_app()  # also lazily creates server.session_manager

        print("[api] MCP: mounted 'prospect-market-intel' at /mcp (Streamable HTTP, stateless).")
        return server, asgi_app
    except Exception as exc:  # noqa: BLE001 — MCP wiring must never take down the API
        print(f"[api] MCP: failed to load ({exc!r}); skipping /mcp mount.")
        close_prospect_mcp()  # module may have opened its conn before the wiring failed
        return None, None
