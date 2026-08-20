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

WHAT THIS DOES INSTEAD — TEACHER/STUDENT
A DistilBERT with two heads (aspect 11-way, sentiment 3-way) was fine-tuned on 6,722 hand-labelled
fragments. That TEACHER reaches 70.7% / 79.9% — but it needs torch, and the droplet has 2 cores,
~2GB usable during the nightly run, Python 3.14 and no scientific wheels, so it can never run
there. It therefore runs on a laptop only, where it labelled 400,000 fragments.

What ships here is the STUDENT distilled from those labels: a linear softmax over bag-of-ngrams.
Training used torch (offline, on a laptop); INFERENCE is a dict lookup and an addition, which is
why this file has no dependencies at all. The whole model is bias + a {feature: [weight per class]}
table, gzipped to ~6MB.

Linear-softmax rather than the Naive Bayes it replaces because NB assumes features are independent
given the class — exactly false for text, where "cheap" + "deaths" is not the product of its parts.

Measured on the same 184-fragment ground truth throughout:

                       regex      NB      student    (teacher)
    aspect correct     42.9%   55.4%      62.5%       70.7%
    sentiment correct  60.3%   67.4%      72.3%       79.9%
    both correct       25.5%   37.0%      44.6%       54.9%

The student keeps ~88% of the teacher's aspect accuracy with none of its cost, and is FASTER than
the Naive Bayes it replaces: ~70,000 fragments/sec, i.e. minutes for the full 15.8M-mention corpus
on one core.

Honest ceiling: the two human raters who produced the ground truth agreed with each other on only
92% of aspects, so this is an 11-way problem with genuinely noisy labels. Roughly one fragment in
three still gets the wrong aspect. The cheapest remaining improvement is more teacher labels — the
distillation set was capped at 400k for time, not because it stopped helping.

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

import gzip
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
MODEL_FILENAME = "aspect_model.json.gz"   # gzipped: the linear model is ~17MB raw, ~4MB packed


def featurize(text: str) -> set[str]:
    """THE feature function — imported by the offline trainer as well, so training and serving can
    never drift. (They did once: the aspect head was trained on unigrams while inference fed it
    bigrams, and unseen features shifted the argmax because each class contributes its own default.
    One shared function is the fix that makes that class of bug impossible.)

    A SET, not a list: the linear model scores presence, not frequency, so a word repeated five
    times in a rant must not outvote five distinct pieces of evidence."""
    words = [t for t in _TOKEN.findall(text.lower()) if len(t) > 1]
    out = {t for t in words if t not in _STOP}
    out.update(f"{a}_{b}" for a, b in zip(words, words[1:]))
    return out


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


# The trainer's label set shortened one aspect's name; ASPECT_LEXICON in build_marts.py — the
# source of truth every downstream mart joins on — spells it out. Renamed here, once, at load:
# the model file stays exactly as trained, and what classify() emits is always a label the rest of
# the pipeline recognises. Left unmapped it fails silently rather than loudly — the rows land under
# an aspect no mart joins to, so the category just looks nearly empty (it did: 11k mentions against
# 900k+ for its neighbours) instead of raising anything.
_CANONICAL_ASPECT = {"Map & Navigation": "Map & Navigation / Backtracking"}


def _canonical(classes: list) -> list:
    return [_CANONICAL_ASPECT.get(c, c) for c in classes]


class AspectClassifier:
    """Loaded once per ETL run and reused; scoring is pure dict lookups, no shared mutable state."""

    def __init__(self, model: dict):
        self.kind = model.get("kind", "nb")
        if self.kind == "linear":
            self._init_linear(model)
            return
        self._aspect = {_CANONICAL_ASPECT.get(k, k): v for k, v in model["aspect"]["classes"].items()}
        self._sentiment = model["sentiment"]["classes"]
        cfg = model.get("config", {})
        # Default True only so an older model file without a config block keeps working.
        self._aspect_bigrams = bool(cfg.get("aspect", {}).get("bigrams", True))
        self._sentiment_bigrams = bool(cfg.get("sentiment", {}).get("bigrams", True))
        self.n_train = model.get("n_train")

    def _init_linear(self, model: dict):
        """Linear softmax head distilled from the transformer teacher: score = bias + the sum of
        the weight rows of whichever features are present. Pruned features are simply absent, which
        is the same as a zero row — no default term, so unlike the Naive Bayes head an unseen
        feature contributes nothing rather than tilting the argmax."""
        self._lin = {}
        for head in ("aspect", "sentiment"):
            h = model[head]
            classes = _canonical(h["classes"]) if head == "aspect" else h["classes"]
            self._lin[head] = (classes, h["bias"], h["weights"])
        self.n_train = model.get("n_train")

    @staticmethod
    def _linear_argmax(classes, bias, weights, feats):
        scores = list(bias)
        for f in feats:
            row = weights.get(f)
            if row is not None:
                for i, w in enumerate(row):
                    scores[i] += w
        best = max(range(len(scores)), key=scores.__getitem__)
        top = scores[best]
        second = max((v for i, v in enumerate(scores) if i != best), default=top)
        return classes[best], top - second

    @classmethod
    def load(cls, path: str) -> "AspectClassifier":
        opener = gzip.open if path.endswith(".gz") else open
        with opener(path, "rt", encoding="utf-8") as fh:
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
        if self.kind == "linear":
            feats = featurize(text)
            if not feats:
                return NONE_LABEL, "neutral", 0.0
            aspect, margin = self._linear_argmax(*self._lin["aspect"], feats)
            sentiment, _ = self._linear_argmax(*self._lin["sentiment"], feats)
            return aspect, sentiment, margin
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
    root = os.path.dirname(os.path.abspath(__file__))
    # .gz first, then the uncompressed name, so a hand-dropped plain JSON still works.
    names = (MODEL_FILENAME, MODEL_FILENAME.removesuffix(".gz"))
    for base in (root, data_dir):
        for name in names:
            candidate = os.path.join(base, name)
            if base and os.path.exists(candidate):
                return AspectClassifier.load(candidate)
    return None
