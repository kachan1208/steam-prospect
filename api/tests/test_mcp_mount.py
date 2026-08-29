"""The mounted MCP must not run tool bodies on the event loop (one slow DuckDB read
would freeze every HTTP request on the worker), must keep logging calls, must rotate the
call log at its size cap without two workers destroying each other's archive, must refuse to
mount at all against a DB whose core marts are missing, and must close its DuckDB
connection via the shutdown hook.

Loads the real mcp/prospect_mcp.py through the real mount path, pointed at the committed
CI smoke fixture (.github/fixtures/mcp_smoke_mart.db) — prospect_mcp reads the
PROSPECT_ANALYTICS_DB_PATH env var at module-exec time, so monkeypatch.setenv is enough
to redirect each fresh load. Tests that need a DB the fixture isn't build a
throwaway DuckDB in tmp_path and load against that instead.
"""
from __future__ import annotations

import json
import threading

import anyio
import duckdb
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


def test_tool_calls_use_a_dedicated_thread_limiter(mcp_server, monkeypatch):
    # Offloading to a thread is only half the fix: anyio's DEFAULT thread limiter is the
    # same 40 slots every sync FastAPI route handler runs in, so MCP calls drawing on it
    # could still starve normal HTTP traffic. They must use their own bounded limiter.
    server, _ = mcp_server
    import anyio.to_thread as to_thread

    orig_run_sync = to_thread.run_sync
    seen: dict = {}

    async def spy_run_sync(fn, *args, **kwargs):
        seen["limiter"] = kwargs.get("limiter")
        seen["default"] = to_thread.current_default_thread_limiter()
        return await orig_run_sync(fn, *args, **kwargs)

    monkeypatch.setattr(to_thread, "run_sync", spy_run_sync)

    async def drive():
        return await server._tool_manager.call_tool("tag_suggest", {"q": ""})

    anyio.run(drive)

    assert seen.get("limiter") is not None, (
        "MCP tool calls fell back to anyio's shared default thread pool"
    )
    assert seen["limiter"] is not seen["default"]
    assert seen["limiter"].total_tokens == mcp_mount._MCP_THREAD_LIMIT


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


def test_rotation_does_not_clobber_the_archive_a_peer_worker_just_made(tmp_path):
    # The two uvicorn workers share this file. Worker A rotates (5MB -> .1) and starts a
    # fresh log; worker B, which saw the over-cap size a moment earlier, must NOT then
    # replace the fresh log over A's archive. _rotate_log re-checks the size under its
    # lock, so B is a no-op — this is worker B's call, post-rotation.
    log_path = tmp_path / "mcp_calls.jsonl"
    archive = tmp_path / "mcp_calls.jsonl.1"
    archive.write_bytes(b"y" * LOG_CAP_BYTES)  # what worker A just rolled off
    log_path.write_text("fresh line\n", encoding="utf-8")

    mcp_mount._rotate_log(str(log_path))

    assert archive.stat().st_size == LOG_CAP_BYTES, "a full archive generation was destroyed"
    assert log_path.read_text(encoding="utf-8") == "fresh line\n"


def test_missing_core_marts_refuses_to_mount(monkeypatch, tmp_path):
    # With every capability probe lazy, nothing else queries the DB before a tool call —
    # so without the eager core-mart check the mount would succeed here and all 25 tools
    # would raise raw CatalogException inside the client. Contract: (None, None).
    empty_db = tmp_path / "martless.duckdb"
    conn = duckdb.connect(str(empty_db))
    conn.execute("CREATE TABLE junk (a INTEGER)")
    conn.close()
    monkeypatch.setenv("PROSPECT_ANALYTICS_DB_PATH", str(empty_db))
    monkeypatch.setattr(settings, "enable_mcp", True)
    monkeypatch.setattr(settings, "mcp_call_log_path", str(tmp_path / "calls.jsonl"))
    try:
        assert mcp_mount.load_prospect_mcp() == (None, None)
        assert mcp_mount._loaded_module is None, "the refused module's conn must be closed"
    finally:
        mcp_mount.close_prospect_mcp()


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
