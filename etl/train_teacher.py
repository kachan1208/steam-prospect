#!/usr/bin/env python3
"""Fine-tune a shared-encoder, two-head transformer on the hand-labelled fragments.

This is the TEACHER. It runs only on the local machine (Apple Silicon / MPS), never on the
droplet: it exists to (a) score the existing corpus once, and (b) generate a large distilled
training set so the lightweight student the droplet runs nightly agrees with it.

One encoder, two heads (aspect 11-way, sentiment 3-way) rather than two fine-tunes: the corpus
pass is the expensive part, and sharing the encoder halves it.
"""
import json, os, random, sys, time
import torch
import torch.nn as nn
from torch.utils.data import Dataset, DataLoader
from transformers import AutoTokenizer, AutoModel

SP = os.path.dirname(os.path.abspath(__file__))
BASE = "distilbert-base-uncased"
DEV = "mps" if torch.backends.mps.is_available() else "cpu"
MAXLEN = 160
SEED = 13

ASPECTS = ["Combat & Bosses", "World & Exploration", "Art & Visuals", "Music & Audio",
           "Story & Writing", "Difficulty", "Controls & Performance", "Map & Navigation",
           "Content & Length", "Price & Value", "NONE"]
SENTS = ["praise", "complaint", "neutral"]
A2I = {a: i for i, a in enumerate(ASPECTS)}
S2I = {s: i for i, s in enumerate(SENTS)}


def norm_aspect(a):
    return "Map & Navigation" if a.startswith("Map & Navigation") else a


class Rows(Dataset):
    def __init__(self, rows, tok):
        self.rows, self.tok = rows, tok

    def __len__(self):
        return len(self.rows)

    def __getitem__(self, i):
        r = self.rows[i]
        enc = self.tok(r["text"], truncation=True, max_length=MAXLEN, padding="max_length",
                       return_tensors="pt")
        return (enc["input_ids"][0], enc["attention_mask"][0],
                torch.tensor(A2I.get(norm_aspect(r["aspect"]), A2I["NONE"])),
                torch.tensor(S2I.get(r["sentiment"], S2I["neutral"])))


class TwoHead(nn.Module):
    def __init__(self):
        super().__init__()
        self.enc = AutoModel.from_pretrained(BASE)
        h = self.enc.config.hidden_size
        self.drop = nn.Dropout(0.15)
        self.aspect = nn.Linear(h, len(ASPECTS))
        self.sentiment = nn.Linear(h, len(SENTS))

    def forward(self, ids, mask):
        # Mean-pool over real tokens: more robust than [CLS] when the fragment is a clause rather
        # than a well-formed sentence, which is what these excerpts usually are.
        out = self.enc(input_ids=ids, attention_mask=mask).last_hidden_state
        m = mask.unsqueeze(-1).float()
        pooled = (out * m).sum(1) / m.sum(1).clamp(min=1e-9)
        pooled = self.drop(pooled)
        return self.aspect(pooled), self.sentiment(pooled)


def main():
    torch.manual_seed(SEED); random.seed(SEED)
    rows = json.load(open(f"{SP}/train_labeled.json"))
    ev = {o["id"]: o for o in json.load(open(f"{SP}/aspect_eval_set.json"))}
    truth = json.load(open(f"{SP}/agreed.json"))
    gt_texts = {ev[t["id"]]["text"] for t in truth if t["id"] in ev}
    rows = [r for r in rows if r["text"] not in gt_texts]          # eval stays clean
    random.shuffle(rows)
    n_val = max(200, len(rows) // 10)
    val, tr = rows[:n_val], rows[n_val:]
    print(f"навчальних {len(tr)}, валідація {len(val)}, пристрій {DEV}")

    tok = AutoTokenizer.from_pretrained(BASE)
    model = TwoHead().to(DEV)
    dl = DataLoader(Rows(tr, tok), batch_size=32, shuffle=True)
    vdl = DataLoader(Rows(val, tok), batch_size=64)
    opt = torch.optim.AdamW(model.parameters(), lr=3e-5, weight_decay=0.01)
    steps = len(dl) * 4
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=3e-5, total_steps=steps, pct_start=0.1)
    lossf = nn.CrossEntropyLoss()

    best, best_state = 0.0, None
    for ep in range(4):
        model.train(); t0 = time.time()
        for ids, mask, ya, ys in dl:
            ids, mask, ya, ys = ids.to(DEV), mask.to(DEV), ya.to(DEV), ys.to(DEV)
            la, ls = model(ids, mask)
            loss = lossf(la, ya) + 0.5 * lossf(ls, ys)
            opt.zero_grad(); loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            opt.step(); sched.step()
        model.eval(); oka = oks = n = 0
        with torch.no_grad():
            for ids, mask, ya, ys in vdl:
                la, ls = model(ids.to(DEV), mask.to(DEV))
                oka += (la.argmax(1).cpu() == ya).sum().item()
                oks += (ls.argmax(1).cpu() == ys).sum().item()
                n += len(ya)
        acc = oka / n
        print(f"  епоха {ep+1}: val аспект {100*acc:.1f}%  сентимент {100*oks/n:.1f}%  ({time.time()-t0:.0f}с)")
        if acc > best:
            best, best_state = acc, {k: v.detach().cpu().clone() for k, v in model.state_dict().items()}

    model.load_state_dict(best_state)
    torch.save({"state": best_state, "aspects": ASPECTS, "sents": SENTS, "base": BASE,
                "maxlen": MAXLEN}, f"{SP}/teacher.pt")

    # Final, clean measurement on the same 184 fragments every earlier number used.
    model.eval(); oka = oks = both = n = 0
    with torch.no_grad():
        for t in truth:
            it = ev.get(t["id"])
            if not it: continue
            e = tok(it["text"], truncation=True, max_length=MAXLEN, padding="max_length", return_tensors="pt")
            la, ls = model(e["input_ids"].to(DEV), e["attention_mask"].to(DEV))
            pa = ASPECTS[la.argmax(1).item()]; ps = SENTS[ls.argmax(1).item()]
            ga = norm_aspect(t["true_aspect"])
            n += 1; oka += pa == ga; oks += ps == t["true_sentiment"]
            both += (pa == ga) and (ps == t["true_sentiment"])
    print(f"\nВЧИТЕЛЬ на {n} ground truth:")
    print(f"  аспект     {100*oka/n:5.1f}%   [регексп 42.9%, NB 55.4%]")
    print(f"  сентимент  {100*oks/n:5.1f}%   [VADER 60.3%, NB 67.4%]")
    print(f"  обидва     {100*both/n:5.1f}%   [регексп 25.5%, NB 37.0%]")


if __name__ == "__main__":
    main()
