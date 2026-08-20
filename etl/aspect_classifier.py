"""Aspect + sentiment classification for review text — replaces judging a mention by the keyword
that matched it.

WHY THIS EXISTS
The pipeline used to decide what a review fragment was ABOUT purely from which keyword regex it
matched, with no word-sense disambiguation. Measured against 184 hand-labelled fragments (two
independent raters, only their agreements scored), that gave:

    aspect correct            42.9%
    sentiment correct         60.3%
    both correct              25.5%
    fragment about NO aspect  22.3%   (and the regex can never say so — it has no NONE)

The failure is inherent to keyword matching: "cheap deaths" is Difficulty, "looks cheap" is Art,
"cheap at 5 bucks" is Price, and "road map" is not Map at all. Per-bucket precision bottomed out
at 11.1% for Map & Navigation, whose keyword `map` is the most polysemous of the lot.

WHAT THIS DOES INSTEAD
Multinomial Naive Bayes trained on 6,722 LLM-labelled review fragments, two heads with separately
cross-validated feature sets: ASPECT uses unigrams with a min-document-frequency of 2, SENTIMENT
uses unigrams + bigrams. Bigrams are what let the sentiment head see `not_worth` and `too_short`
as single signals; the aspect head generalised better without them once there was enough data,
which is why the two disagree and why the model file records the choice per head.

Measured on the same 184-fragment ground truth as the numbers above:

    aspect correct     42.9% -> 55.4%
    sentiment correct  60.3% -> 67.4%
    both correct       25.5% -> 37.0%

Still far from solved — roughly two fragments in five get the wrong aspect — but it is right more
often than wrong, which the keyword regex never was. The learning curve was still climbing when
the labelling budget ran out (CV 0.271 at 150 examples, 0.439 at 842, 0.579 at 6,722), so more
labels remain the cheapest available improvement.

WHY NAIVE BAYES AND NOT SOMETHING STRONGER
No numpy, scipy or scikit-learn is installed on the droplet, the box has 2 cores and ~2GB of
usable RAM during the nightly run, and its Python is 3.14 — betting the nightly pipeline on the
availability of scientific wheels for that combination is not a trade worth making. NB trains in
milliseconds, serialises to a plain dict of log-probabilities, and scores with dict lookups, so it
drops into the existing streaming pattern (see _stream_vader_scores) with zero new dependencies.

The regex is NOT deleted: it still generates candidate mentions, where its recall is the point.
This module decides what each candidate is actually about — including rejecting it as NONE.
"""
from __future__ import annotations

import json
import math
import os
import re
from typing import Iterable

# Kept identical to the trainer; changing either side alone silently degrades accuracy.
_TOKEN = re.compile(r"[a-z0-9']+")
_STOP = {
    "the", "a", "an", "and", "or", "but", "if", "of", "to", "in", "is", "it", "this", "that",
    "was", "for", "on", "with", "as", "at", "be", "by", "are", "from", "you", "i", "my", "me",
    "so", "just", "have", "has", "not", "no", "its", "they", "he", "she", "them", "their",
    "there", "then", "than", "also", "can", "will",
}

NONE_LABEL = "NONE"
MODEL_FILENAME = "aspect_model.json"


def features(text: str, use_bigrams: bool = True) -> list[str]:
    """Unigrams (stopworded), optionally + bigrams (stopwords KEPT — "not_worth" and "too_short"
    are the signal, and dropping the function word would destroy them).

    use_bigrams MUST match what the head was trained with. The two heads disagree — cross
    validation picked unigrams for aspect and bigrams for sentiment — and feeding a unigram-trained
    head bigram features is not harmless: every unseen feature contributes that class's `default`
    log-probability, and those defaults differ per class, so the extra features tilt the argmax."""
    words = [t for t in _TOKEN.findall(text.lower()) if len(t) > 1]
    out = [t for t in words if t not in _STOP]
    if use_bigrams:
        out += [f"{a}_{b}" for a, b in zip(words, words[1:])]
    return out


class AspectClassifier:
    """Loaded once per ETL run and reused; scoring is pure dict lookups, no shared mutable state."""

    def __init__(self, model: dict):
        self._aspect = model["aspect"]["classes"]
        self._sentiment = model["sentiment"]["classes"]
        cfg = model.get("config", {})
        # Default True only so an older model file without a config block keeps working.
        self._aspect_bigrams = bool(cfg.get("aspect", {}).get("bigrams", True))
        self._sentiment_bigrams = bool(cfg.get("sentiment", {}).get("bigrams", True))
        self.n_train = model.get("n_train")

    @classmethod
    def load(cls, path: str) -> "AspectClassifier":
        with open(path, "r", encoding="utf-8") as fh:
            return cls(json.load(fh))

    @staticmethod
    def _argmax(classes: dict, feats: list[str]) -> tuple[str, float]:
        best_label, best_score, second = None, -1e18, -1e18
        for label, m in classes.items():
            score = m["log_prior"]
            lik, default = m["log_lik"], m["default"]
            for f in feats:
                score += lik.get(f, default)
            if score > best_score:
                best_label, second, best_score = label, best_score, score
            elif score > second:
                second = score
        # Margin in log-space between the winner and the runner-up: the pipeline uses it to drop
        # coin-flip calls rather than present them as findings.
        return best_label, best_score - second

    def classify(self, text: str) -> tuple[str, str, float]:
        """-> (aspect, sentiment, margin). aspect may be NONE, which means "this fragment does not
        discuss any tracked aspect" — a verdict the keyword regex was structurally unable to give."""
        uni = features(text, use_bigrams=False)
        if not uni:
            return NONE_LABEL, "neutral", 0.0
        bi = features(text, use_bigrams=True)
        aspect, margin = self._argmax(self._aspect, bi if self._aspect_bigrams else uni)
        sentiment, _ = self._argmax(self._sentiment, bi if self._sentiment_bigrams else uni)
        return aspect, sentiment, margin

    def classify_many(self, texts: Iterable[str]) -> list[tuple[str, str, float]]:
        return [self.classify(t) for t in texts]


def load_default(data_dir: str) -> "AspectClassifier | None":
    """Model lives next to the ETL code, not in the data dir: it is versioned with the code that
    produced it. Returns None when absent so the caller can fall back to keyword behaviour rather
    than fail the whole nightly build."""
    here = os.path.join(os.path.dirname(os.path.abspath(__file__)), MODEL_FILENAME)
    for candidate in (here, os.path.join(data_dir, MODEL_FILENAME)):
        if os.path.exists(candidate):
            return AspectClassifier.load(candidate)
    return None
