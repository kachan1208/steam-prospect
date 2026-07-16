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

O5 (chat productionization): the backend is mode-switchable via PROSPECT_CHAT_MODE=
subscription|api (config.py::settings.chat_mode). "subscription" (default) is the CLI path
above, unchanged. "api" drives the Anthropic SDK directly (gated on ANTHROPIC_API_KEY) with
its OWN small tool surface (find_niches/market_benchmarks/estimate_revenue/game_search — a
subset of the 12 MCP tools, re-implemented as thin direct queries against analytics_db rather
than spawning a subprocess or cross-importing mcp/prospect_mcp.py, which owns its own DB
connection and deliberately doesn't share code with api/app/* — see that file's docstring).
Both paths emit the SAME SSE event contract (text/tool_call/tool_result/error/done), so the
frontend needs no changes regardless of mode. Every completed turn (either mode) appends one
line to PROSPECT_CHAT_USAGE_LOG_PATH — a per-tenant usage log + the entitlement quota hook
that reads it back (see _log_chat_usage / _chat_messages_today / entitlements.chat_quota_exceeded).
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import threading
from collections.abc import Generator
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse

from .. import analytics_db, benchmarks
from ..auth import get_current_org, get_entitlements
from ..config import REPO_ROOT, settings
from ..entitlements import Entitlements, chat_quota_exceeded
from ..models import Org
from ..schemas import ChatRequest, ChatStatus
from .estimate import _genre_owners_per_review

router = APIRouter(prefix="/api/chat", tags=["chat"])

# ---- O5: usage log path (append-only JSONL; see module docstring) ---------------------
USAGE_LOG_PATH = settings.chat_usage_log_path

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
NO_API_KEY_MESSAGE = (
    "PROSPECT_CHAT_MODE=api but ANTHROPIC_API_KEY is not set. Set it (billed per-query via "
    "the Anthropic API), or unset PROSPECT_CHAT_MODE to fall back to the subscription CLI path."
)


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


# ==========================================================================================
# O5 "api" mode — Anthropic SDK path, gated on ANTHROPIC_API_KEY
# ==========================================================================================
# Default model when PROSPECT_CHAT_MODEL is unset. Deliberately Opus-tier: this is a
# per-query-metered analytics assistant, not a bulk pipeline, so quality-per-query matters
# more than shaving cost — override via PROSPECT_CHAT_MODEL if a cheaper tier fits better.
API_DEFAULT_MODEL = "claude-opus-4-8"
API_MAX_TOKENS = 4096
# Bounds the tool-use loop the same way MAX_TURNS bounds the subscription path above.
API_MAX_TOOL_TURNS = 8

# api-mode's tool surface is intentionally a SUBSET of the 12 MCP tools (find_niches,
# market_benchmarks, estimate_revenue, game_search) — enough to keep answers grounded
# without re-deriving all 12 query shapes a second time in this file. Extend this list if
# api mode needs teardown/press/launch-timing parity later.
API_SYSTEM_PROMPT = """You are Prospect's in-app analytics assistant for solo/indie Steam game \
developers, running in metered API mode (a smaller tool surface than the subscription mode's \
in-app assistant). Answer questions about market benchmarks, revenue estimates, specific games, \
and what to build — grounded in Prospect's DuckDB marts (a Steam snapshot of ~142K apps, \
SteamSpy owner estimates, ~3M sampled reviews).

Use ONLY these tools to fetch data: find_niches, market_benchmarks, estimate_revenue, \
game_search. Ground every quantitative claim in a tool call — never invent numbers, game \
names, appids, genres, or tag labels. If a tool returns {"error": ...}, read it (it usually \
names the valid values) and retry with a correction.

Revenue (est_rev_reviews / estimate_revenue) is GROSS lifetime box revenue via the Boxleiter \
method (owners ~= reviews x 20-55, genre-dependent), not net-of-Steam's-cut — report \
estimate_revenue's low/mid/high range, never a lone number. All figures are estimates with \
real biases (reviews are a recency-biased sample) — surface a caveat when it matters.

Style: answer directly and concisely. Use a small markdown table when comparing several rows; \
otherwise state the number inline."""

API_TOOLS: list[dict[str, Any]] = [
    {
        "name": "find_niches",
        "description": (
            "Rank niches (Steam community tags by default, or Steam genres) by an "
            "opportunity score (0-100, higher = better for a new entrant): fuses demand "
            "(market size/heat), competition (crowding — high is bad), and quality_gap "
            "(share of weak incumbents — high means easier to out-execute). Call this "
            "first for 'what should I build' questions."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "dimension": {
                    "type": "string",
                    "enum": ["tag", "genre"],
                    "description": "tag = SteamSpy's large community-tag vocabulary "
                    "(specific micro-niches); genre = Steam's small fixed genre list. "
                    "Default tag.",
                },
                "window": {
                    "type": "string",
                    "enum": ["all", "24m"],
                    "description": "all = full history; 24m = last 24 months only "
                    "(current-market read). Default all.",
                },
                "min_reviews": {
                    "type": "integer",
                    "enum": [10, 50],
                    "description": "Per-game review floor before a title counts toward "
                    "niche stats. Default 10.",
                },
                "sort": {"type": "string", "description": "Column to sort by. Default opportunity."},
                "limit": {"type": "integer", "description": "Max rows to return (<=50). Default 15."},
            },
        },
    },
    {
        "name": "market_benchmarks",
        "description": (
            "Reference anchors for judging any revenue/owners number: cited indie-market "
            "research figures (median indie gross, Boxleiter owners-per-review, dev-tier "
            "definitions) plus this catalog's own computed medians and fitted Boxleiter "
            "slope per genre. Call this before quoting any dollar figure."
        ),
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "estimate_revenue",
        "description": (
            "Estimate lifetime owners + gross/net revenue from EITHER a review count OR "
            "a wishlist count (provide exactly one), plus price and optionally genre. "
            "Returns low/mid/high ranges — always report the range, never a single number."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "price": {"type": "number", "description": "Launch price in USD."},
                "reviews": {"type": "integer", "description": "Total review count (Boxleiter-method basis)."},
                "wishlists": {"type": "integer", "description": "Wishlist count (wishlist-conversion basis)."},
                "genre": {"type": "string", "description": "Exact Steam genre label — strongly recommended when known."},
            },
            "required": ["price"],
        },
    },
    {
        "name": "game_search",
        "description": (
            "Search/filter the game catalog (only games with >=10 sampled reviews). Use "
            "this to find a specific game, spot-check top players in a niche/genre, or "
            "look up a game's stats."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "q": {"type": "string", "description": "Case-insensitive substring match on game name."},
                "tag": {"type": "string", "description": "Exact match against the game's top community tags."},
                "genre": {"type": "string", "description": "Exact Steam genre label (matches primary genre only)."},
                "min_reviews": {"type": "integer", "description": "Minimum total review count. Default 0."},
                "sort": {"type": "string", "description": "Column to sort by. Default total_reviews."},
                "limit": {"type": "integer", "description": "Max rows to return (<=50). Default 15."},
            },
        },
    },
]

_API_NICHE_SORTABLE = {  # mirrors routers/niches.py::SORTABLE (independent on purpose — see
    # mcp/prospect_mcp.py's header on why this codebase tolerates this kind of duplication)
    "key", "opportunity", "demand", "competition", "quality_gap",
    "median_rev", "median_reviews", "median_price", "median_owners",
    "median_positive_ratio", "recent_velocity", "n_games", "n_recent",
    "hit_rate_200k", "hit_rate_500k", "beatable_share", "saturation_yoy",
    "self_pub_share", "winner_concentration",
}
_API_GAME_SORTABLE = {
    "name", "release_year", "price_initial", "owners_mid", "total_reviews",
    "positive_ratio", "est_rev_reviews", "rev_pct_in_genre", "reviews_pct_in_genre",
    "owners_pct_in_genre", "n_reviews_trailing_30d",
}


def _clean_floats(value: Any, nd: int = 4) -> Any:
    """Round floats (recursively) so DuckDB float noise (75524.40000000001) doesn't burn
    tokens on garbage digits — every tool result is billed input tokens on the next turn."""
    if isinstance(value, float):
        return round(value, nd)
    if isinstance(value, dict):
        return {k: _clean_floats(v, nd) for k, v in value.items()}
    if isinstance(value, list):
        return [_clean_floats(v, nd) for v in value]
    return value


def _tool_find_niches(
    dimension: str = "tag",
    window: str = "all",
    min_reviews: int = 10,
    sort: str = "opportunity",
    limit: int = 15,
) -> dict:
    if dimension not in ("tag", "genre"):
        return {"error": "dimension must be 'tag' or 'genre'"}
    if window not in ("all", "24m"):
        return {"error": "window must be 'all' or '24m'"}
    if int(min_reviews) not in (10, 50):
        return {"error": "min_reviews must be 10 or 50"}
    if sort not in _API_NICHE_SORTABLE:
        return {"error": f"sort must be one of {sorted(_API_NICHE_SORTABLE)}"}
    limit = max(1, min(int(limit or 15), 50))
    rows = analytics_db.query(
        f"""
        SELECT key, n_games, n_recent, opportunity, demand, competition, quality_gap,
               median_rev, median_reviews, median_price, median_positive_ratio,
               median_owners, recent_velocity, hit_rate_200k, hit_rate_500k,
               saturation_yoy, winner_concentration
        FROM mart_niche WHERE dimension = ? AND win = ? AND min_reviews = ?
        ORDER BY {sort} DESC NULLS LAST, n_games DESC LIMIT ?
        """,
        [dimension, window, int(min_reviews), limit],
    )
    return {"dimension": dimension, "window": window, "min_reviews": min_reviews, "niches": rows}


def _tool_market_benchmarks() -> dict:
    meta = {r["key"]: r["value"] for r in analytics_db.query("SELECT key, value FROM mart_meta")}
    boxleiter = analytics_db.query(
        "SELECT genre, n, owners_per_review_median, slope FROM mart_market_boxleiter "
        "ORDER BY n DESC LIMIT 25"
    )
    return {"cited": benchmarks.as_dict(), "computed_meta": meta, "boxleiter_by_genre": boxleiter}


def _tool_estimate_revenue(
    price: float,
    reviews: int | None = None,
    wishlists: int | None = None,
    genre: str | None = None,
) -> dict:
    if (reviews is None) == (wishlists is None):
        return {"error": "Provide exactly one of `reviews` or `wishlists`."}
    lo = float(benchmarks.BOXLEITER_OWNERS_PER_REVIEW_MIN)
    hi = float(benchmarks.BOXLEITER_OWNERS_PER_REVIEW_MAX)
    genre_used, opr_mid = _genre_owners_per_review(genre)  # reused from routers/estimate.py
    if reviews is not None:
        basis = "reviews"
        owners = {"low": reviews * lo, "mid": reviews * opr_mid, "high": reviews * hi}
    else:
        basis = "wishlists"
        wl_lo, wl_hi = benchmarks.WISHLIST_CONVERSION_RANGE
        mult = benchmarks.FIRST_WEEK_TO_FIRST_YEAR_MULT
        owners = {
            "low": wishlists * wl_lo * mult,
            "mid": wishlists * benchmarks.WISHLIST_CONVERSION_FIRST_WEEK * mult,
            "high": wishlists * wl_hi * mult,
        }
    revenue_gross = {k: v * price for k, v in owners.items()}
    share = benchmarks.STEAM_REVENUE_SHARE_TO_DEV
    revenue_net = {k: v * share for k, v in revenue_gross.items()}
    return {
        "basis": basis,
        "genre": genre_used,
        "owners": owners,
        "revenue_gross_usd": revenue_gross,
        "revenue_net_usd": revenue_net,
        "dev_tier": benchmarks.tier_for_copies(owners["mid"]),
    }


def _tool_game_search(
    q: str | None = None,
    tag: str | None = None,
    genre: str | None = None,
    min_reviews: int = 0,
    sort: str = "total_reviews",
    limit: int = 15,
) -> dict:
    if sort not in _API_GAME_SORTABLE:
        return {"error": f"sort must be one of {sorted(_API_GAME_SORTABLE)}"}
    where = ["total_reviews >= ?"]
    params: list = [int(min_reviews or 0)]
    if q:
        where.append("name ILIKE ?")
        params.append(f"%{q}%")
    if genre:
        where.append("primary_genre = ?")
        params.append(genre)
    if tag:
        where.append("list_contains(top_tags, ?)")
        params.append(tag)
    limit = max(1, min(int(limit or 15), 50))
    rows = analytics_db.query(
        f"""
        SELECT appid, name, primary_genre, release_year, price_initial, owners_mid,
               total_reviews, positive_ratio, est_rev_reviews, top_tags
        FROM mart_game WHERE {" AND ".join(where)}
        ORDER BY {sort} DESC NULLS LAST, total_reviews DESC LIMIT ?
        """,
        params + [limit],
    )
    return {"games": rows}


def _dispatch_api_tool(name: str, tool_input: dict) -> dict:
    """Runs one tool call and returns its JSON-able result. Never raises — a tool bug
    surfaces to the model as {"error": ...} (which the system prompt tells it to read and
    retry from) instead of crashing the SSE stream."""
    try:
        if name == "find_niches":
            result = _tool_find_niches(**tool_input)
        elif name == "market_benchmarks":
            result = _tool_market_benchmarks()
        elif name == "estimate_revenue":
            result = _tool_estimate_revenue(**tool_input)
        elif name == "game_search":
            result = _tool_game_search(**tool_input)
        else:
            return {"error": f"unknown tool: {name}"}
    except Exception as exc:  # noqa: BLE001 - a tool bug shouldn't crash the chat stream
        return {"error": f"tool {name} failed: {exc}"}
    return _clean_floats(result)


# ---- O5: per-tenant chat usage log + entitlement quota hook -----------------------------
def _log_chat_usage(org_id: int, mode: str, **extra: Any) -> None:
    """Append-only usage log: one JSON line per completed chat turn (see module docstring
    and config.py::chat_usage_log_path). Deliberately a flat file, not a new control-plane
    table, so O5 needs no schema migration; swap for an indexed store if per-request log
    scans in _chat_messages_today ever stop being cheap enough."""
    try:
        USAGE_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        row = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "org_id": org_id,
            "mode": mode,
            **extra,
        }
        with USAGE_LOG_PATH.open("a", encoding="utf-8") as f:
            f.write(json.dumps(row, default=str) + "\n")
    except OSError:
        pass  # usage logging must never break the chat response


def _chat_messages_today(org_id: int) -> int:
    if not USAGE_LOG_PATH.exists():
        return 0
    today = datetime.now(timezone.utc).date().isoformat()
    count = 0
    try:
        with USAGE_LOG_PATH.open("r", encoding="utf-8") as f:
            for line in f:
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if row.get("org_id") == org_id and str(row.get("timestamp", "")).startswith(today):
                    count += 1
    except OSError:
        return 0
    return count


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


def _stream_chat(history: list[dict[str, str]], org_id: int) -> Generator[bytes, None, None]:
    """One turn: spawn `claude -p`, translate its stream-json events into our SSE contract.
    Never raises — every failure mode is surfaced as an `error` event so the stream never
    500s and the frontend always gets a clean `done`."""
    try:
        yield from _stream_chat_subscription(history)
    finally:
        _log_chat_usage(org_id, "subscription")


def _stream_chat_subscription(history: list[dict[str, str]]) -> Generator[bytes, None, None]:
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


def _stream_chat_api(history: list[dict[str, str]], org_id: int) -> Generator[bytes, None, None]:
    """One turn via the Anthropic SDK (PROSPECT_CHAT_MODE=api). Manual agentic tool-use
    loop: stream text deltas as they arrive, then dispatch any tool_use blocks in the
    completed message and continue until the model stops asking for tools (or
    API_MAX_TOOL_TURNS is hit). Never raises — every failure mode is an `error` event, same
    contract as _stream_chat_subscription above."""
    if not settings.anthropic_api_key:
        yield _sse("error", {"message": NO_API_KEY_MESSAGE, "code": "missing_api_key"})
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

    usage_extra: dict[str, Any] = {}
    try:
        try:
            import anthropic
        except ImportError:
            yield _sse("error", {"message": "The `anthropic` package isn't installed."})
            return

        client = anthropic.Anthropic(api_key=settings.anthropic_api_key)
        model = settings.chat_model or API_DEFAULT_MODEL
        usage_extra["model"] = model
        messages: list[dict[str, Any]] = [{"role": "user", "content": _flatten_history(history)}]

        for _ in range(API_MAX_TOOL_TURNS):
            with client.messages.stream(
                model=model,
                max_tokens=API_MAX_TOKENS,
                system=API_SYSTEM_PROMPT,
                tools=API_TOOLS,
                messages=messages,
            ) as stream:
                for event in stream:
                    if (
                        event.type == "content_block_delta"
                        and event.delta.type == "text_delta"
                        and event.delta.text
                    ):
                        yield _sse("text", {"text": event.delta.text})
                final = stream.get_final_message()

            usage_extra["input_tokens"] = usage_extra.get("input_tokens", 0) + final.usage.input_tokens
            usage_extra["output_tokens"] = usage_extra.get("output_tokens", 0) + final.usage.output_tokens
            messages.append({"role": "assistant", "content": final.content})

            if final.stop_reason == "refusal":
                yield _sse("error", {"message": "The assistant declined to answer that request."})
                break
            if final.stop_reason != "tool_use":
                break

            tool_results = []
            for block in final.content:
                if block.type != "tool_use":
                    continue
                yield _sse("tool_call", {"name": block.name, "input": block.input or {}})
                result = _dispatch_api_tool(block.name, block.input or {})
                yield _sse("tool_result", {"name": block.name})
                tool_results.append(
                    {
                        "type": "tool_result",
                        "tool_use_id": block.id,
                        "content": json.dumps(result, default=str),
                    }
                )
            messages.append({"role": "user", "content": tool_results})
        else:
            yield _sse(
                "error",
                {"message": f"Reached the turn limit ({API_MAX_TOOL_TURNS}) without a final answer."},
            )
    except Exception as exc:  # noqa: BLE001 - never let the stream crash the server
        message = getattr(exc, "message", None) or str(exc)
        yield _sse("error", {"message": f"Anthropic API error: {message}"[:600]})
    finally:
        _log_chat_usage(org_id, "api", **usage_extra)
        yield _sse("done", {})


@router.get("/status", response_model=ChatStatus)
def chat_status(org: Org = Depends(get_current_org)) -> ChatStatus:
    """Cheap readiness probe the frontend polls to decide whether to show the composer or the
    setup empty-state. In subscription mode, checks only that the CLI exists and the marts
    are loaded (it does not launch `claude`, so it can't verify login — a signed-out CLI
    surfaces on the first send). In api mode, checks that ANTHROPIC_API_KEY is set and the
    marts are loaded."""
    if settings.chat_mode == "api":
        return ChatStatus(
            ready=bool(settings.anthropic_api_key) and analytics_db.is_ready(),
            model=settings.chat_model or API_DEFAULT_MODEL,
        )
    return ChatStatus(
        ready=_claude_bin() is not None and analytics_db.is_ready(),
        model=settings.chat_model or "Claude Code (subscription)",
    )


@router.post("")
def chat(
    req: ChatRequest,
    org: Org = Depends(get_current_org),
    ent: Entitlements = Depends(get_entitlements),
) -> StreamingResponse:
    history = [{"role": m.role, "content": m.content} for m in req.messages if m.content and m.content.strip()]
    if chat_quota_exceeded(ent, _chat_messages_today(org.id)):
        raise HTTPException(status_code=402, detail="Daily chat-message quota reached for your plan.")
    stream_fn = _stream_chat_api if settings.chat_mode == "api" else _stream_chat
    return StreamingResponse(
        stream_fn(history, org.id),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
