"""Guard: the sentiment cache is only as valid as the CODE that filled it.

sentiment_cache.duckdb keeps every score forever — ~20M aspect_mention rows (VADER compound +
the classifier's clf_aspect / clf_sentiment / clf_margin) and ~200K press_article compounds —
and the nightly only ever scores reviews it has not seen. What invalidates it is
_sentiment_config_hash, which covers the model FILE, the lexicon, the VADER overrides, the window
sizing and the thresholds — and NOT the code that turns a window into a score: the classifier's
tokenizer / feature function / argmax in etl/aspect_classifier.py, the glue in build_marts'
_score_windows / _get_analyzer and the window cut in _aspect_window_sql, or the vaderSentiment
package itself. Change any of those and the nightly carries on happily, scoring new reviews with
the new code while serving millions scored by the old one: two scorers in one cache, invisible
in every mart.

That is not hypothetical. 821fc82 (2026-09-09) changed how the classifier sums its weights
(sorted feature order instead of set-iteration order) and said so in its own comment — two
classes within a rounding error could get a different verdict — and nothing forced a decision
about the cache. (Measured afterwards on 88,399 real windows x 8 summation orders: one exact tie,
i.e. ~1 verdict in 90K; no rescore warranted. But it was luck that it was small, not a check.)

This test pins a fingerprint of exactly that code (normalised AST: comments, docstrings and
formatting do not count) and of the installed VADER (version + lexicon files + module code). When
it fails, DECIDE — do not just re-pin:

  (a) the change CAN alter a score or a verdict for some input: bump SENTIMENT_CACHE_VERSION in
      etl/build_marts.py. That wipes and refills the cache — a multi-night rescore of ~24M
      reviews — so it is scheduled by the owner, never shipped as a side effect. Then re-pin.
  (b) you have established it cannot (a refactor, a log line, a type annotation): re-pin.

Either way the new values are printed in the failure message.
"""
from __future__ import annotations

import ast
import hashlib
import importlib.metadata
import inspect
import sys
import textwrap
from pathlib import Path

ETL = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ETL))

import aspect_classifier  # noqa: E402
import build_marts as bm  # noqa: E402

# ---- THE PINS. Change only after deciding (a) or (b) above. ----------------------------------
PINNED_CLASSIFIER_CODE = "2946c2167c538db893b7757ec6000429468ba8f7995da2d1f95966dd25695a25"
PINNED_SCORING_GLUE = "307c1c3be31fa251524448cad676e33572001700927f8bc83c040d502f475516"
PINNED_VADER_VERSION = "3.3.2"
PINNED_VADER_FINGERPRINT = "15316b08defb295fed407add049a09d070f5500fa64b2b5a5388bd69897c6b21"


def _strip_docstrings(tree: ast.AST) -> ast.AST:
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            body = node.body
            if (body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant)
                    and isinstance(body[0].value.value, str)):
                node.body = body[1:] or [ast.Pass()]
    return tree


def _canon(node) -> str:
    """A serialisation of the AST that ignores what cannot change behaviour (line numbers,
    comments, docstrings, formatting) and is stable across Python versions that add optional
    fields: None and [] fields are skipped rather than printed."""
    if isinstance(node, ast.AST):
        parts = []
        for name, value in ast.iter_fields(node):
            if value is None or value == [] or name == "type_comment":
                continue
            parts.append(f"{name}={_canon(value)}")
        return f"{type(node).__name__}({','.join(parts)})"
    if isinstance(node, list):
        return "[" + ",".join(_canon(v) for v in node) + "]"
    return repr(node)


def _code_hash(*sources: str) -> str:
    h = hashlib.sha256()
    for src in sources:
        h.update(_canon(_strip_docstrings(ast.parse(textwrap.dedent(src)))).encode("utf-8"))
        h.update(b"\x00")
    return h.hexdigest()


def classifier_code() -> str:
    """ALL of etl/aspect_classifier.py: every line of it is on the scoring path — the tokenizer,
    the stopwords, featurize()/features(), the aspect-name mapping, the argmax, and which model
    file load_default() picks."""
    return _code_hash(Path(aspect_classifier.__file__).read_text(encoding="utf-8"))


def scoring_glue() -> str:
    """The build_marts side of a score: which text window each mention is scored on
    (_aspect_window_sql and the keyword-position regex it slices by — the window constants
    themselves ARE in the config hash, the SQL that applies them is not), how a window becomes
    (compound, clf_aspect, clf_sentiment, clf_margin), and the one analyzer (with its overrides
    applied) it uses. A window-cut change must be proven byte-identical — see
    tests/test_aspect_window_sql_rewrite.py — or bump the version."""
    return _code_hash(inspect.getsource(bm._score_windows), inspect.getsource(bm._get_analyzer),
                      inspect.getsource(bm._aspect_window_sql),
                      inspect.getsource(bm._aspect_keyword_position_regex))


def vader_version() -> str:
    return importlib.metadata.version("vaderSentiment")


def vader_fingerprint() -> str:
    """The installed VADER's scoring code and its lexicons, byte for byte — a version string alone
    would miss a patched or vendored copy."""
    import vaderSentiment.vaderSentiment as vs
    pkg = Path(vs.__file__).parent
    h = hashlib.sha256(_code_hash(Path(vs.__file__).read_text(encoding="utf-8")).encode())
    for name in ("vader_lexicon.txt", "emoji_utf8_lexicon.txt"):
        h.update(name.encode())
        h.update((pkg / name).read_bytes())
    return h.hexdigest()


def test_sentiment_scoring_code_is_pinned():
    now = {
        "PINNED_CLASSIFIER_CODE": classifier_code(),
        "PINNED_SCORING_GLUE": scoring_glue(),
        "PINNED_VADER_VERSION": vader_version(),
        "PINNED_VADER_FINGERPRINT": vader_fingerprint(),
    }
    pinned = {k: globals()[k] for k in now}
    moved = {k: (pinned[k], now[k]) for k in now if pinned[k] != now[k]}
    assert not moved, (
        "\nThe sentiment SCORING CODE changed, and the sentiment cache cannot see code changes:\n"
        + "".join(f"  {k}: pinned {old!r}\n  {' ' * len(k)}  now    {new!r}\n"
                  for k, (old, new) in moved.items())
        + f"\nsentiment_cache.duckdb holds scores from the OLD code, and _sentiment_config_hash "
          f"(SENTIMENT_CACHE_VERSION={bm.SENTIMENT_CACHE_VERSION}) does not cover code, so the "
          "nightly would mix two scorers in one cache. DECIDE, then re-pin in "
          "etl/tests/test_sentiment_scoring_code_pin.py:\n"
          "  (a) the change CAN alter a compound, a clf_* verdict or a clf_margin for some input:\n"
          "      bump SENTIMENT_CACHE_VERSION in etl/build_marts.py — a full, multi-night rescore\n"
          "      of ~24M reviews that the OWNER schedules — and re-pin;\n"
          "  (b) you have confirmed it cannot (refactor / logging / typing): re-pin only.\n"
    )
