#!/usr/bin/env python3
"""Teacher labels the corpus locally; the output is the student's training set.

The student (pure Python, no deps) is what the droplet runs nightly on new reviews. Training it on
6,722 human labels capped it at 55.4% aspect. Training it instead on hundreds of thousands of
TEACHER labels is ordinary distillation: the student stops being limited by how much text a human
labelled and starts being limited only by how well it can imitate a 70.7% model.

Writes incrementally so a long run can be resumed, and so a kill never loses the work already done.
"""
import json, os, sys, time
import duckdb, torch
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from train_teacher import TwoHead, ASPECTS, SENTS, DEV, MAXLEN, BASE
from transformers import AutoTokenizer

SP = os.path.dirname(os.path.abspath(__file__))
OUT = f"{SP}/distilled.duckdb"
BATCH = 128
LIMIT = int(os.environ.get("DISTIL_LIMIT", "1600000"))


def main():
    ck = torch.load(f"{SP}/teacher.pt", map_location="cpu")
    tok = AutoTokenizer.from_pretrained(BASE)
    model = TwoHead(); model.load_state_dict(ck["state"]); model.to(DEV).eval()

    out = duckdb.connect(OUT)
    out.execute("CREATE TABLE IF NOT EXISTS labels(text VARCHAR PRIMARY KEY, aspect VARCHAR, sentiment VARCHAR)")
    done = {r[0] for r in out.execute("SELECT text FROM labels").fetchall()}
    print(f"вже розмічено: {len(done):,}")

    src = duckdb.connect("/Users/maximbaginskiy/hobby/prospect/data/current.duckdb", read_only=True)
    rows = src.execute(f"""
        SELECT DISTINCT regexp_replace(excerpt, '\\s+', ' ', 'g') AS t
        FROM mart_game_aspect_reviews
        WHERE excerpt IS NOT NULL AND length(excerpt) BETWEEN 30 AND 600
        LIMIT {LIMIT}
    """).fetchall()
    todo = [r[0] for r in rows if r[0] not in done]
    print(f"до розмітки: {len(todo):,} унікальних фрагментів")

    t0, n = time.time(), 0
    buf = []
    with torch.no_grad():
        for i in range(0, len(todo), BATCH):
            chunk = todo[i:i + BATCH]
            e = tok(chunk, truncation=True, max_length=MAXLEN, padding=True, return_tensors="pt")
            la, ls = model(e["input_ids"].to(DEV), e["attention_mask"].to(DEV))
            pa = la.argmax(1).cpu().tolist(); ps = ls.argmax(1).cpu().tolist()
            buf.extend((chunk[k], ASPECTS[pa[k]], SENTS[ps[k]]) for k in range(len(chunk)))
            n += len(chunk)
            if len(buf) >= 20000:
                out.executemany("INSERT OR IGNORE INTO labels VALUES (?,?,?)", buf); buf.clear()
                rate = n / (time.time() - t0)
                print(f"  {n:,}/{len(todo):,}  {rate:,.0f}/с  залишилось ~{(len(todo)-n)/rate/60:.0f} хв", flush=True)
    if buf:
        out.executemany("INSERT OR IGNORE INTO labels VALUES (?,?,?)", buf)
    total = out.execute("SELECT count(*) FROM labels").fetchone()[0]
    print(f"ГОТОВО: {total:,} розмічених фрагментів у {OUT}")


if __name__ == "__main__":
    main()
