"""The mounted MCP must not run tool bodies on the event loop (one slow DuckDB read
would freeze every HTTP request on the worker), must keep logging calls, must rotate the
call log at its size cap, and must close its DuckDB connection via the shutdown hook.

Loads the real mcp/prospect_mcp.py through the real mount path, pointed at the committed
CI smoke fixture (.github/fixtures/mcp_smoke_mart.db) — prospect_mcp reads the
PROSPECT_ANALYTICS_DB_PATH env var at module-exec time, so monkeypatch.setenv is enough
to redirect each fresh load.
"""
from __future__ import annotations

import json
import threading

import anyio
import pytest

from app import mcp_mount
from app.config import REPO_ROOT, settings

FIXTURE_DB = REPO_ROOT / ".github" / "fixtures" / "mcp_smoke_mart.db"

# mcp_mount caps the live log at ~5MB with a single .1 rollover.
LOG_CAP_BYTES = mcp_mount._MAX_LOG_BYTES


@pytest.fixture()
def mcp_server(monkeypatch, tmp_path):
    if not FIXTURE_DB.exists():
        pytest.skip("mcp smoke fixture not present")
    monkeypatch.setenv("PROSPECT_ANALYTICS_DB_PATH", str(FIXTURE_DB))
    monkeypatch.setattr(settings, "enable_mcp", True)
    log_path = tmp_path / "mcp_calls.jsonl"
    monkeypatch.setattr(settings, "mcp_call_log_path", str(log_path))
    server, asgi_app = mcp_mount.load_prospect_mcp()
    assert server is not None and asgi_app is not None
    try:
        yield server, log_path
    finally:
        mcp_mount.close_prospect_mcp()


def test_tool_calls_run_off_the_event_loop_and_are_logged(mcp_server):
    server, log_path = mcp_server

    # Spy on the loaded module's query() (every tool funnels through it) to record which
    # thread actually executes the blocking DB work.
    tool_fn = server._tool_manager.get_tool("tag_suggest").fn
    module_globals = tool_fn.__globals__
    orig_query = module_globals["query"]
    seen: dict = {}

    def spy_query(sql, params=None):
        seen["query_thread"] = threading.get_ident()
        return orig_query(sql, params)

    module_globals["query"] = spy_query
    try:
        async def drive():
            seen["loop_thread"] = threading.get_ident()
            return await server._tool_manager.call_tool("tag_suggest", {"q": "a"})

        result = anyio.run(drive)
    finally:
        module_globals["query"] = orig_query

    assert "query_thread" in seen, "the tool body never ran"
    assert seen["query_thread"] != seen["loop_thread"], (
        "sync tool executed ON the event loop thread — the anyio.to_thread offload in "
        "mcp_mount._observed_call is not taking effect"
    )
    assert isinstance(result, dict) and "tags" in result

    # The logging behavior of the wrapper must be preserved by the offload.
    lines = log_path.read_text(encoding="utf-8").splitlines()
    assert lines, "call log not written"
    entry = json.loads(lines[-1])
    assert entry["tool"] == "tag_suggest"
    assert entry["ok"] is True
    assert isinstance(entry["ms"], int)


def test_call_log_rotates_at_size_cap(mcp_server):
    server, log_path = mcp_server

    # Pre-fill the live log past the cap; the next logged call must roll it to .1 and
    # start a fresh file containing only the new entry.
    filler = ("x" * 1023 + "\n") * (LOG_CAP_BYTES // 1024 + 1)
    log_path.write_text(filler, encoding="utf-8")
    assert log_path.stat().st_size >= LOG_CAP_BYTES

    async def drive():
        return await server._tool_manager.call_tool("tag_suggest", {"q": "a"})

    anyio.run(drive)

    archive = log_path.parent / (log_path.name + ".1")
    assert archive.exists(), "no .1 rollover created"
    assert archive.stat().st_size >= LOG_CAP_BYTES
    lines = log_path.read_text(encoding="utf-8").splitlines()
    assert len(lines) == 1, "rotated live log should hold only the post-rotation entry"
    assert json.loads(lines[0])["tool"] == "tag_suggest"


def test_close_hook_closes_module_connection(mcp_server):
    server, _ = mcp_server
    module = mcp_mount._loaded_module
    assert module is not None

    mcp_mount.close_prospect_mcp()
    assert mcp_mount._loaded_module is None
    # Idempotent: safe to call again (the fixture teardown will too).
    mcp_mount.close_prospect_mcp()
    # The module's own close() is idempotent as well.
    module.close()
    with pytest.raises(Exception):
        module.query("SELECT 1")
