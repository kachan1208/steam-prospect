# CI fixtures

## `mcp_smoke_mart.db` (~6.5MB, tracked binary)

A tiny, curated, **real-data-derived** DuckDB mart. CI's `mcp-smoke` job points
`PROSPECT_ANALYTICS_DB_PATH` at it and runs `mcp/smoke_test.py` against it
(`.github/workflows/ci.yml`).

It contains real rows, not synthetic ones, because `mcp/smoke_test.py` asserts on
**specific real entities** — appid 367520 = "Hollow Knight", the "Open World Survival
Craft" tag niche, the "Action"/"RPG" genres. Satisfying those with synthetic data would
mean reimplementing the whole scoring pipeline in the fixture builder. Instead the builder
pulls exactly the rows those assertions touch out of a real ~557MB `data/current.duckdb`
via DuckDB's cross-database `ATTACH` (exact schema, types and values — no transcription).

The extension is `.db`, not `.duckdb`, so the repo's blanket `*.duckdb` gitignore rule
doesn't swallow it. This is the one mart that is meant to be committed.

### Regenerate RARELY — each regeneration costs ~6.5MB of git history, forever

Git stores a whole new blob for every version of a binary file, and nothing ever removes
the old ones: **each regeneration permanently adds ~6.5MB to the repository**, paid by
every clone from then on (no `git rm` or later commit reclaims it — only a history
rewrite would).

So regenerate **only on a schema break** — i.e. when `mcp/smoke_test.py` fails against
this fixture because the mart's *shape* changed (a renamed/dropped column, a new required
table). Do **not** regenerate to refresh data: the fixture's job is to exercise the MCP
tools' code paths, and nothing in the smoke test cares how current the numbers are. If a
`smoke_test.py` assertion drifts (e.g. some other niche overtakes "Open World Survival
Craft" in a fresh mart), prefer adjusting the assertion or the builder's curation over
committing a new binary.

### Regeneration command

Needs a real, already-built mart locally (run `task etl` first if you don't have one):

```bash
api/.venv/bin/python .github/scripts/build_mcp_fixture.py
# or, from a worktree checkout with no data/ of its own:
api/.venv/bin/python .github/scripts/build_mcp_fixture.py /path/to/data/current.duckdb
```

The script is **not** run in CI (CI has no access to the real mart) and it writes
`.github/fixtures/mcp_smoke_mart.db` in place. Read its module docstring before rerunning
— it documents exactly which rows are curated in and which two are deliberately omitted to
keep the smoke test's `top_key` assertion true. Verify before committing:

```bash
cd mcp && PROSPECT_ANALYTICS_DB_PATH=../.github/fixtures/mcp_smoke_mart.db python smoke_test.py
```
