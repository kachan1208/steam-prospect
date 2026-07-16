"""Analytics Chat — grounded in Prospect's marts, powered by the user's Claude Code login.

Instead of calling the Anthropic API directly (which needs a paid API key), this drives the
local `claude` CLI in headless mode against the Prospect MCP server (mcp/prospect_mcp.py — the
same 12 analytics tools exposed to any Claude client). So the in-app chat runs on the user's
existing Claude Code subscription: no ANTHROPIC_API_KEY, no per-query API billing.

POST /api/chat streams one turn as SSE. The event contract is unchanged from the original
API-backed version, so the frontend needs no changes:
    text        {text}            incremental assistant text
    tool_call   {name, input}     an analytics tool started (name without the mcp__ prefix)
    tool_result {name}            that tool returned (clears the "calling …" indicator)
    error       {message, code?}  something went wrong
    done        {}                stream finished
We spawn `claude -p ... --output-format stream-json` and translate its event stream into the
above. The subprocess runs the whole tool-use loop; we only relay.

Trade-off (intentional — see the SaaS plan): this is a LOCAL, single-user solution. Anthropic's
terms don't allow serving other users off a personal subscription, so a hosted multi-tenant
deployment would still need API billing (or each user bringing their own auth).
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import threading
from collections.abc import Generator
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse

from .. import analytics_db
from ..auth import get_current_org
from ..config import REPO_ROOT, settings
from ..models import Org
from ..schemas import ChatRequest, ChatStatus

router = APIRouter(prefix="/api/chat", tags=["chat"])

MCP_CONFIG_PATH = REPO_ROOT / ".mcp.json"
MCP_SERVER_NAME = "prospect-market-intel"
MCP_TOOL_PREFIX = f"mcp__{MCP_SERVER_NAME}__"
# Cap agentic turns per question. Claude Code routes MCP tools through a ToolSearch step
# (deferred tools), which spends a turn or two, so budget above the ~2-3 a simple answer needs.
MAX_TURNS = 16

# Env keys scrubbed from the subprocess so `claude` runs as a normal top-level invocation on
# the user's login: the CLAUDE_CODE* markers would flag it as a nested session, and a stray
# ANTHROPIC_API_KEY would route it through paid API billing instead of the subscription.
_SCRUB_ENV_EXACT = {"CLAUDECODE", "ANTHROPIC_API_KEY", "CLAUDE_EFFORT"}

NO_CLI_MESSAGE = (
    "Claude Code CLI not found. Install it and sign in with your Claude subscription "
    "(`claude` on your PATH) — the in-app chat runs on your Claude Code login, not an API key."
)
NOT_LOGGED_IN_MESSAGE = (
    "Claude Code isn't signed in. Run `claude` once in a terminal to log in with your "
    "subscription, then try again."
)
MARTS_NOT_READY_MESSAGE = "Analytics marts are not loaded — run the ETL and restart the API."


SYSTEM_PROMPT = """You are Prospect's in-app analytics assistant for solo/indie Steam game \
developers. Answer questions about what to build, market benchmarks, revenue estimates, \
specific games, press/marketing contacts, and launch timing — grounded in Prospect's DuckDB \
marts (a Steam snapshot of ~142K apps, SteamSpy owner estimates, ~3M sampled reviews, ~1M \
press articles).

Use ONLY the prospect-market-intel tools to fetch data: find_niches, niche_detail, \
market_benchmarks, revenue_distribution, estimate_revenue, game_search, game_profile, \
game_teardown, press_pitch_list, buzz_trends, launch_shape, best_launch_timing. Do NOT use \
shell, file, web, or code-editing tools. Ground every quantitative claim in a tool call — \
never invent numbers, game names, appids, genres, or tag labels. If a tool returns \
{"error": ...}, read it (it usually names the valid values) and retry with a correction.

Key concepts:
- opportunity (find_niches / niche_detail) fuses demand (market size/heat), competition \
(crowding — HIGH is bad for a new entrant), and quality_gap (share of weak incumbents — HIGH \
means easier to out-execute), each a 0-100 percentile.
- dimension="tag" is SteamSpy's large community-tag vocabulary (specific micro-niches, usually \
more actionable); "genre" is Steam's small fixed list — get exact genre labels from \
market_benchmarks or a game result before calling genre-scoped tools (a misspelled genre \
silently returns nothing).
- Revenue (est_rev_reviews / estimate_revenue) is GROSS lifetime box revenue via the Boxleiter \
method (owners ≈ reviews × 20-55, genre-dependent), not net-of-Steam's-cut and not \
first-year-only — report estimate_revenue's low/mid/high range, never a lone number.
- All figures are estimates with real biases (reviews/press are recency-biased samples; any \
"why it works" or press read is correlational, not causal) — surface a tool's caveats when \
they matter to the answer.

Style: answer directly and concisely. Use a small markdown table when comparing several rows \
(niches, games, outlets); otherwise state the number inline. Ask a clarifying question only if \
the request is genuinely ambiguous; otherwise make a reasonable default call (window="all", \
min_reviews=10) and proceed."""


def _claude_bin() -> str | None:
    """Absolute path to the `claude` CLI, or None if it isn't installed."""
    found = shutil.which("claude")
    if found:
        return found
    fallback = "/opt/homebrew/bin/claude"
    return fallback if Path(fallback).exists() else None


def _subprocess_env() -> dict[str, str]:
    return {
        k: v
        for k, v in os.environ.items()
        if k not in _SCRUB_ENV_EXACT and not k.startswith("CLAUDE_CODE")
    }


def _short_tool_name(name: str) -> str:
    """`mcp__prospect-market-intel__find_niches` -> `find_niches`."""
    return name[len(MCP_TOOL_PREFIX):] if name.startswith(MCP_TOOL_PREFIX) else name


def _flatten_history(history: list[dict[str, str]]) -> str:
    """The frontend POSTs the full turn history each call, but `claude -p` takes a single
    prompt. Fold prior turns into a transcript so follow-ups keep context, then pose the
    latest user message as the question."""
    if len(history) == 1:
        return history[0]["content"]
    prior = "\n\n".join(
        f"{'User' if m['role'] == 'user' else 'Assistant'}: {m['content']}" for m in history[:-1]
    )
    return (
        "Earlier in this conversation:\n"
        f"{prior}\n\n"
        f"Now answer the user's new message:\n{history[-1]['content']}"
    )


def _sse(event: str, data: dict[str, Any]) -> bytes:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n".encode("utf-8")


def _claude_command(prompt: str) -> list[str]:
    claude = _claude_bin()
    assert claude is not None  # guarded by the caller
    cmd = [
        claude,
        "-p",
        prompt,
        "--output-format",
        "stream-json",
        "--verbose",  # required to emit the full event stream in print mode
        "--include-partial-messages",  # token-by-token text deltas
        "--mcp-config",
        str(MCP_CONFIG_PATH),
        "--strict-mcp-config",  # load ONLY the prospect server, not the user's global ones
        "--allowedTools",
        f"mcp__{MCP_SERVER_NAME}",  # auto-approve every prospect tool; deny everything else
        "--max-turns",
        str(MAX_TURNS),
    ]
    if settings.chat_model:
        cmd += ["--model", settings.chat_model]
    cmd += ["--append-system-prompt", SYSTEM_PROMPT]
    return cmd


def _stream_chat(history: list[dict[str, str]]) -> Generator[bytes, None, None]:
    """One turn: spawn `claude -p`, translate its stream-json events into our SSE contract.
    Never raises — every failure mode is surfaced as an `error` event so the stream never
    500s and the frontend always gets a clean `done`."""
    if _claude_bin() is None:
        yield _sse("error", {"message": NO_CLI_MESSAGE, "code": "missing_cli"})
        yield _sse("done", {})
        return
    if not analytics_db.is_ready():
        yield _sse("error", {"message": MARTS_NOT_READY_MESSAGE, "code": "marts_not_ready"})
        yield _sse("done", {})
        return
    if not history:
        yield _sse("error", {"message": "No message provided."})
        yield _sse("done", {})
        return

    proc = subprocess.Popen(
        _claude_command(_flatten_history(history)),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=str(REPO_ROOT),
        env=_subprocess_env(),
        text=True,
        bufsize=1,
    )
    # Drain stderr on a thread so a chatty stderr can't deadlock the stdout pipe.
    stderr_chunks: list[str] = []
    threading.Thread(target=lambda: stderr_chunks.extend(proc.stderr or []), daemon=True).start()

    tool_by_id: dict[str, str] = {}  # tool_use id -> short name (only prospect tools we surfaced)
    emitted_text = False
    emitted_error = False
    try:
        for raw in proc.stdout:  # type: ignore[union-attr]
            line = raw.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            otype = obj.get("type")

            if otype == "stream_event":
                ev = obj.get("event", {})
                etype = ev.get("type")
                if etype == "content_block_delta":
                    delta = ev.get("delta", {})
                    if delta.get("type") == "text_delta":
                        text = delta.get("text") or ""
                        if text:
                            emitted_text = True
                            yield _sse("text", {"text": text})
                elif etype == "content_block_start":
                    blk = ev.get("content_block", {})
                    if blk.get("type") == "tool_use":
                        name = blk.get("name") or ""
                        if name.startswith(MCP_TOOL_PREFIX):  # hide ToolSearch/built-ins
                            short = _short_tool_name(name)
                            if blk.get("id"):
                                tool_by_id[blk["id"]] = short
                            yield _sse("tool_call", {"name": short, "input": blk.get("input") or {}})

            elif otype == "user":
                # Tool results come back as a user message; clear the indicator for ours.
                for blk in obj.get("message", {}).get("content", []) or []:
                    if isinstance(blk, dict) and blk.get("type") == "tool_result":
                        short = tool_by_id.pop(blk.get("tool_use_id"), None)
                        if short:
                            yield _sse("tool_result", {"name": short})

            elif otype == "result":
                if obj.get("is_error") and not emitted_text:
                    msg = obj.get("result") or obj.get("error") or "The chat run failed."
                    yield _sse("error", {"message": str(msg)[:600]})
                    emitted_error = True
                break

        proc.wait(timeout=5)
    except Exception as exc:  # noqa: BLE001 - never let the stream crash the server
        if not emitted_text and not emitted_error:
            yield _sse("error", {"message": f"Unexpected error: {exc}"})
            emitted_error = True
    finally:
        if proc.poll() is None:
            proc.terminate()
        # If nothing came back at all, the most likely cause is a not-signed-in / launch failure.
        if not emitted_text and not emitted_error:
            stderr_tail = "".join(stderr_chunks).strip()[-600:]
            low = stderr_tail.lower()
            if any(s in low for s in ("log in", "login", "authenticate", "unauthorized", "api key")):
                message = NOT_LOGGED_IN_MESSAGE
            elif stderr_tail:
                message = f"Chat failed to run: {stderr_tail}"
            else:
                message = "The assistant returned no output. Check that Claude Code is signed in."
            yield _sse("error", {"message": message})
        yield _sse("done", {})


@router.get("/status", response_model=ChatStatus)
def chat_status(org: Org = Depends(get_current_org)) -> ChatStatus:
    """Cheap readiness probe the frontend polls to decide whether to show the composer or the
    setup empty-state. Checks only that the CLI exists and the marts are loaded — it does not
    launch `claude` (so it can't verify login; a signed-out CLI surfaces on the first send)."""
    return ChatStatus(
        ready=_claude_bin() is not None and analytics_db.is_ready(),
        model=settings.chat_model or "Claude Code (subscription)",
    )


@router.post("")
def chat(req: ChatRequest, org: Org = Depends(get_current_org)) -> StreamingResponse:
    history = [{"role": m.role, "content": m.content} for m in req.messages if m.content and m.content.strip()]
    return StreamingResponse(
        _stream_chat(history),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
