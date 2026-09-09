"""Suite-wide defaults for the ETL tests."""
from __future__ import annotations

import os

import pytest


@pytest.fixture(autouse=True)
def _score_inline_unless_asked(monkeypatch):
    """Pin the INLINE sentiment scoring path for every test unless the environment already
    says otherwise (a test that wants the pool sets PROSPECT_SCORE_WORKERS itself).

    Unset, PROSPECT_SCORE_WORKERS defaults to min(3, cpu_count - 1) worker processes — on a
    dev box that is a pool of spawned interpreters in every test that reaches
    compute_aspect_sentiment or repair_sentiment_arms, which is slow and noisy and not the
    path the deterministic tests exist to pin. The pooled path has its own tests
    (test_sentiment_score_workers.py) that hold it to the inline path's output byte for
    byte; everything else runs inline. Exporting PROSPECT_SCORE_WORKERS before pytest runs
    the whole suite through a pool instead."""
    if "PROSPECT_SCORE_WORKERS" not in os.environ:
        monkeypatch.setenv("PROSPECT_SCORE_WORKERS", "1")
