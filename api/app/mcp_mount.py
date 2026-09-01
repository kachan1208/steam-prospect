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
import os
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

# How many worker threads MCP tool calls may occupy at once. They get their OWN anyio
# limiter rather than drawing on the process-wide default one (40 slots), which is the
# same pool every sync FastAPI route handler runs in — otherwise a burst of slow MCP
# calls could still drain it and freeze normal HTTP traffic, a weaker version of the
# exact problem the off-loop offload exists to fix. 4 because: prospect_mcp serializes
# ALL of its reads on one module-global connection lock, so extra threads only deepen a
# queue that cannot go wider; it matches the REST side's 4-cursor DuckDB pool on this
# 2-vCPU box; and it leaves 36 of the 40 shared slots for the API no matter what the MCP
# is doing.
_MCP_THREAD_LIMIT = 4


class SDKInternalsChanged(RuntimeError):
    """The installed mcp SDK no longer exposes the private internals load_prospect_mcp()
    patches (server._tool_manager.call_tool / list_tools). Raised UNCAUGHT on purpose:
    a SDK bump must fail the boot loudly instead of silently skipping the observability
    wiring — or worse, silently mounting an un-instrumented /mcp."""


def _tool_manager_or_raise(server: Any) -> Any:
    """Return server._tool_manager after asserting the private surface this module patches.

    The tool-call metrics/log wrapper and the sync-tool offload both monkeypatch
    ToolManager.call_tool — the single choke point every tool invocation passes through.
    If the SDK renamed or removed these internals, continuing would skip that wiring
    WITHOUT SAYING SO; raise a loud, named error instead."""
    tool_manager = getattr(server, "_tool_manager", None)
    if (
        tool_manager is None
        or not callable(getattr(tool_manager, "call_tool", None))
        or not callable(getattr(tool_manager, "list_tools", None))
    ):
        raise SDKInternalsChanged(
            "FastMCP SDK internals changed: expected server._tool_manager with "
            "call_tool() and list_tools(). mcp_mount.py patches these private "
            "attributes for per-tool metrics, the call log and the worker-thread "
            "offload — update it for the installed mcp SDK version."
        )
    return tool_manager


def _rotate_log(path: str) -> None:
    """Roll `path` to `path`.1 under an exclusive sidecar lock (best-effort).

    Cross-process on purpose: both uvicorn workers append to this file. The lock holder
    RE-CHECKS the size before replacing, so a worker that queued behind a peer's rotation
    sees the fresh log and does nothing — without that re-check the two workers rotate
    back-to-back and the second os.replace overwrites the full archive the first just
    created with a near-empty file, destroying a whole 5MB generation. flock is dropped by
    the kernel if a worker dies, so there is no stale-lock failure mode. Callers wrap this
    in `except OSError` (missing file, unwritable dir); on a platform without fcntl it
    degrades to the unguarded rotation.
    """
    archive = f"{path}.1"
    try:
        import fcntl
    except ImportError:  # pragma: no cover — POSIX everywhere we run (Linux prod, macOS dev)
        os.replace(path, archive)
        return
    lock_fd = os.open(f"{path}.lock", os.O_CREAT | os.O_WRONLY, 0o644)
    try:
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            return  # a peer worker is rotating right now; it does the work, we just append
        try:
            if os.path.getsize(path) >= _MAX_LOG_BYTES:  # re-check under the lock
                os.replace(path, archive)
        finally:
            fcntl.flock(lock_fd, fcntl.LOCK_UN)
    finally:
        os.close(lock_fd)


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
        # Re-load counterpart to close_prospect_mcp(): exec_module opens a NEW read-only
        # DuckDB connection, so release whatever a previous load left behind first —
        # otherwise a second load in this process (tests, a reload hook) leaks the old one.
        close_prospect_mcp()
        spec.loader.exec_module(module)  # defines the tools; guarded __main__ won't run
        global _loaded_module
        _loaded_module = module  # conn is open from here on — track it for shutdown close

        # The one EAGER check, and the reason this module's "no marts -> (None, None)"
        # contract still holds now that prospect_mcp's capability probes are all lazy:
        # nothing else queries the DB before a tool is called, so a mart-less or
        # half-built current.duckdb (the failed / OOM-killed nightly ETL) would import
        # fine, mount /mcp, advertise all 25 tools, and then raise raw CatalogException
        # inside every connected Claude client — with no startup line saying so.
        missing = module.missing_core_marts()
        if missing:
            print(
                f"[api] MCP: ERROR — analytics DB {module.DB_PATH} is missing or has empty "
                f"core marts {missing}; NOT mounting /mcp (the tools would all fail at call "
                "time). Re-run the ETL and restart."
            )
            close_prospect_mcp()
            return None, None

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
                # the single .1 archive (overwriting the previous one) and a fresh log
                # starts — so an append-forever log can't eat the disk. Both uvicorn
                # workers write here, so the swap itself is serialized + size-re-checked
                # inside _rotate_log; doing it unguarded lets the second worker overwrite
                # the archive the first just made, losing a whole generation.
                try:
                    if os.path.getsize(_log_path) >= _MAX_LOG_BYTES:
                        _rotate_log(_log_path)
                except OSError:
                    pass  # first write (no file yet) or a racing worker already rotated
                with open(_log_path, "a", encoding="utf-8") as fh:
                    fh.write(line + "\n")
            except Exception:
                pass

        # Assert the private SDK surface BEFORE touching it (see _tool_manager_or_raise):
        # an SDK bump that renamed these internals must fail the boot, not silently skip
        # the metrics/log/offload wiring below.
        tool_manager = _tool_manager_or_raise(server)
        _orig_call = tool_manager.call_tool

        # Self-enforcement of the offload's CONSTRAINT (see _observed_call): a tool taking
        # a Context must stay on the SERVER event loop, because Context methods talk to
        # the client session over it and cannot be driven from the worker thread's private
        # loop. FastMCP records the Context argument's name on each Tool as `context_kwarg`,
        # so this is an attribute scan at registration time rather than a comment nobody
        # reads. The set is empty today; a future Context tool announces itself here and
        # silently opts out of the offload instead of failing subtly at call time.
        _ctx_tools = frozenset(
            t.name for t in tool_manager.list_tools() if t.context_kwarg is not None
        )
        if _ctx_tools:
            print(
                "[api] MCP: WARNING — these tools take a Context, so they run ON the event "
                f"loop (no thread offload; a slow one blocks HTTP): {sorted(_ctx_tools)}"
            )

        # One CapacityLimiter per running event loop (the mechanism anyio itself uses for
        # its default thread limiter) so a limiter is never reused across loops — uvicorn
        # workers get one each, and tests that spin a fresh loop per anyio.run() don't
        # inherit one bound to a dead loop.
        from anyio.lowlevel import RunVar as _RunVar

        _limiter_var = _RunVar("prospect_mcp_thread_limiter")

        def _mcp_limiter():
            try:
                return _limiter_var.get()
            except LookupError:
                import anyio

                limiter = anyio.CapacityLimiter(_MCP_THREAD_LIMIT)
                _limiter_var.set(limiter)
                return limiter

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
            # connection lock — correct, just not parallel. The threads come from the MCP's
            # OWN limiter (_MCP_THREAD_LIMIT), not anyio's shared default pool, so the MCP
            # can never starve the sync FastAPI route handlers. CONSTRAINT: this relies on
            # the tool not taking a Context parameter — Context methods talk to the client
            # session over the SERVER loop and must not be driven from the worker loop;
            # the _ctx_tools scan above enforces it, and those tools run inline instead.
            _bound = partial(_orig_call, name, arguments, *a, **kw)
            try:
                if name in _ctx_tools:
                    result = await _bound()
                else:
                    result = await anyio.to_thread.run_sync(
                        lambda: anyio.run(_bound), limiter=_mcp_limiter()
                    )
            except Exception:
                _log_call(name, arguments, ok=False, ms=int((_time.monotonic() - t0) * 1000))
                raise
            _log_call(name, arguments, ok=True, ms=int((_time.monotonic() - t0) * 1000))
            return result

        tool_manager.call_tool = _observed_call
        print(f"[api] MCP: tool-call observability on (metrics={'yes' if _tool_calls else 'no'}, log={_log_path or 'off'}); sync tools offloaded to a dedicated {_MCP_THREAD_LIMIT}-thread pool.")
        asgi_app = server.streamable_http_app()  # also lazily creates server.session_manager

        print("[api] MCP: mounted 'prospect-market-intel' at /mcp (Streamable HTTP, stateless).")
        return server, asgi_app
    except SDKInternalsChanged:
        raise  # an SDK bump must fail the boot loudly, never silently skip the mount wiring
    except Exception as exc:  # noqa: BLE001 — MCP wiring must never take down the API
        print(f"[api] MCP: failed to load ({exc!r}); skipping /mcp mount.")
        close_prospect_mcp()  # module may have opened its conn before the wiring failed
        return None, None
