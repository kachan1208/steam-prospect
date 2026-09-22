"""/mcp without a trailing slash (api/app/main.py).

The MCP endpoint is the mount ROOT, /mcp/. A Starlette Mount only matches "/mcp/...", so a
client configured with ".../mcp" fell through to the SPA catch-all and got a 404 (the
catch-all rightly refuses to serve the SPA shell there, and because it DID match, Starlette's
own slash redirect never ran). With the MCP enabled, /mcp now 307s to /mcp/ — method and body
preserved, so a JSON-RPC POST arrives intact. Routing only; transport security is untouched.

The suite runs with the MCP disabled, so the registration helper is exercised on a scratch
app with a stand-in mount and the same kind of catch-all main.py registers last.
"""
from __future__ import annotations

import json

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from app import main as app_main


def _app_with_mcp() -> FastAPI:
    async def fake_mcp(scope, receive, send):
        body = b""
        while True:
            msg = await receive()
            body += msg.get("body", b"")
            if not msg.get("more_body"):
                break
        payload = json.dumps(
            {"method": scope["method"], "path": scope["path"], "body": body.decode()}
        ).encode()
        await send({"type": "http.response.start", "status": 200,
                    "headers": [(b"content-type", b"application/json")]})
        await send({"type": "http.response.body", "body": payload})

    scratch = FastAPI()
    app_main._register_mcp_slash_redirect(scratch)
    scratch.mount("/mcp", fake_mcp)

    @scratch.get("/{full_path:path}")
    def catch_all(full_path: str):
        if full_path.split("/", 1)[0] == "mcp":
            raise HTTPException(status_code=404)
        return {"spa": full_path}

    return scratch


def test_bare_mcp_path_redirects_to_the_mount_preserving_the_method():
    c = TestClient(_app_with_mcp())
    for method in ("GET", "POST", "DELETE"):
        r = c.request(method, "/mcp", follow_redirects=False)
        assert r.status_code == 307, method
        assert r.headers["location"] == "/mcp/"
    r = c.post("/mcp?session=abc", follow_redirects=False)
    assert r.headers["location"] == "/mcp/?session=abc"


def test_a_json_rpc_post_to_the_bare_path_arrives_intact():
    c = TestClient(_app_with_mcp())
    rpc = {"jsonrpc": "2.0", "id": 1, "method": "tools/list"}
    r = c.post("/mcp", json=rpc)  # follows the 307
    assert r.status_code == 200
    got = r.json()
    assert got["method"] == "POST"
    assert json.loads(got["body"]) == rpc


def test_the_mount_itself_is_untouched():
    c = TestClient(_app_with_mcp())
    assert c.post("/mcp/", json={}).json()["method"] == "POST"


def test_mcp_disabled_keeps_the_honest_404(client):
    """With the MCP off (this suite) nothing is registered: /mcp stays the SPA guard's 404,
    never a redirect into nothing."""
    assert app_main._mcp_asgi is None
    r = client.get("/mcp", follow_redirects=False)
    assert r.status_code == 404
