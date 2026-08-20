#!/usr/bin/env python3
"""Distil the transformer teacher into a linear model the droplet can run with no dependencies.

The split that makes this work: TRAINING may use torch (it happens here, on a laptop), but
INFERENCE must be a dict lookup and an addition, because that is all the droplet can afford. A
linear softmax over bag-of-ngrams satisfies both — the learned weights export to plain JSON and
scoring is `score[c] = b[c] + sum(W[feature][c] for feature in text)`.

Why linear-softmax rather than the Naive Bayes it replaces: NB assumes features are independent
given the class, which is exactly false for text ("cheap" + "deaths" is not the product of its
parts). Logistic regression learns the weights jointly and, on the same features, is normally
several points better — and here it also gets to learn from ~400k teacher labels instead of 6,722
human ones.
"""
import json, math, os, random, sys, time
from collections import Counter

import duckdb
import torch
import torch.nn as nn

SP = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SP)
from train_teacher import ASPECTS, SENTS, norm_aspect
sys.path.insert(0, "/Users/maximbaginskiy/hobby/prospect/etl")
from aspect_classifier import featurize        # THE shared feature function — never redefine here

DEV = "mps" if torch.backends.mps.is_available() else "cpu"
MIN_DF = 3
MAX_FEATURES = 120_000
EPOCHS = 6


def build_vocab(texts):
    df = Counter()
    for t in texts:
        df.update(set(featurize(t)))
    keep = [f for f, c in df.most_common() if c >= MIN_DF][:MAX_FEATURES]
    return {f: i for i, f in enumerate(keep)}


def to_rows(texts, vocab):
    """Sparse bag-of-features as (indices, offsets) for nn.EmbeddingBag — the cheap way to train a
    linear model over sparse text without materialising a dense matrix."""
    idx, off = [], []
    for t in texts:
        off.append(len(idx))
        ids = {vocab[f] for f in featurize(t) if f in vocab}
        if not ids:
            ids = {0}
        idx.extend(ids)
    return torch.tensor(idx, dtype=torch.long), torch.tensor(off, dtype=torch.long)


class Linear(nn.Module):
    def __init__(self, n_feat, n_cls):
        super().__init__()
        self.emb = nn.EmbeddingBag(n_feat, n_cls, mode="sum")
        self.bias = nn.Parameter(torch.zeros(n_cls))
        nn.init.zeros_(self.emb.weight)

    def forward(self, idx, off):
        return self.emb(idx, off) + self.bias


def train_head(texts, labels, classes, vocab, name):
    y = torch.tensor([classes.index(l) for l in labels], dtype=torch.long)
    idx, off = to_rows(texts, vocab)
    model = Linear(len(vocab), len(classes)).to(DEV)
    opt = torch.optim.AdamW(model.parameters(), lr=0.05, weight_decay=1e-5)
    lossf = nn.CrossEntropyLoss()
    n = len(texts); bs = 4096
    order = list(range(n))
    for ep in range(EPOCHS):
        random.shuffle(order); tot = 0.0
        for s in range(0, n, bs):
            sel = order[s:s + bs]
            # Rebuild the sparse batch from the flat arrays.
            bidx, boff = [], []
            for r in sel:
                boff.append(len(bidx))
                end = off[r + 1].item() if r + 1 < n else len(idx)
                bidx.extend(idx[off[r].item():end].tolist())
            bi = torch.tensor(bidx or [0], dtype=torch.long).to(DEV)
            bo = torch.tensor(boff, dtype=torch.long).to(DEV)
            logits = model(bi, bo)
            loss = lossf(logits, y[sel].to(DEV))
            opt.zero_grad(); loss.backward(); opt.step()
            tot += loss.item() * len(sel)
        print(f"    {name} епоха {ep+1}: loss {tot/n:.4f}", flush=True)
    return model


def export(model, classes, vocab):
    W = model.emb.weight.detach().cpu().tolist()
    b = model.bias.detach().cpu().tolist()
    # Prune features that never move any class much: keeps the shipped JSON small without
    # measurably changing the argmax.
    out = {}
    for f, i in vocab.items():
        row = W[i]
        if max(abs(v) for v in row) >= 0.02:
            out[f] = [round(v, 4) for v in row]
    return {"classes": classes, "bias": [round(v, 4) for v in b], "weights": out}


def main():
    con = duckdb.connect(f"{SP}/distilled.duckdb", read_only=True)
    rows = con.execute("SELECT text, aspect, sentiment FROM labels").fetchall()
    print(f"дистильованих прикладів: {len(rows):,}")
    # Human labels are kept in the mix: they are the only labels not inheriting the teacher's bias.
    human = json.load(open(f"{SP}/train_labeled.json"))
    ev = {o["id"]: o for o in json.load(open(f"{SP}/aspect_eval_set.json"))}
    truth = json.load(open(f"{SP}/agreed.json"))
    gt = {ev[t["id"]]["text"] for t in truth if t["id"] in ev}

    texts = [r[0] for r in rows if r[0] not in gt] + [h["text"] for h in human if h["text"] not in gt]
    asp = [norm_aspect(r[1]) for r in rows if r[0] not in gt] + [norm_aspect(h["aspect"]) for h in human if h["text"] not in gt]
    sen = [r[2] for r in rows if r[0] not in gt] + [h["sentiment"] for h in human if h["text"] not in gt]
    print(f"навчальних після виключення eval: {len(texts):,}")

    t0 = time.time()
    vocab = build_vocab(texts)
    print(f"словник: {len(vocab):,} ознак ({time.time()-t0:.0f}с)")

    ma = train_head(texts, asp, ASPECTS, vocab, "аспект")
    ms = train_head(texts, sen, SENTS, vocab, "сентимент")

    model = {"aspect": export(ma, ASPECTS, vocab), "sentiment": export(ms, SENTS, vocab),
             "kind": "linear", "n_train": len(texts)}
    path = f"{SP}/student_model.json"
    json.dump(model, open(path, "w"))
    print(f"учень збережено: {os.path.getsize(path)/1024/1024:.1f} МБ, "
          f"{len(model['aspect']['weights']):,} ознак")


if __name__ == "__main__":
    main()
