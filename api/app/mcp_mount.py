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
        asgi_app = server.streamable_http_app()  # also lazily creates server.session_manager

        print("[api] MCP: mounted 'prospect-market-intel' at /mcp (Streamable HTTP, stateless).")
        return server, asgi_app
    except Exception as exc:  # noqa: BLE001 — MCP wiring must never take down the API
        print(f"[api] MCP: failed to load ({exc!r}); skipping /mcp mount.")
        return None, None
