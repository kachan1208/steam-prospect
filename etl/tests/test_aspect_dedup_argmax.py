"""Does arg_max(...) pick the SAME row as row_number()...WHERE rn=1?

The dedup in compute_aspect_sentiment was rewritten from a window function to a hash
aggregate because the window sorts the whole 15M-row cache and blew the spill budget two
nights running. Same pick, different execution — this proves the "same pick" half, including
the edge case that would silently drop rows: a group whose clf_margin is NULL for every row
(the model-absent path), which arg_max ignores unless a sentinel is supplied.
"""
from __future__ import annotations

import duckdb

con = duckdb.connect(":memory:")
con.execute("""
CREATE TABLE m(recommendationid VARCHAR, appid INTEGER, aspect VARCHAR, clf_aspect VARCHAR,
               clf_sentiment VARCHAR, clf_margin DOUBLE, compound DOUBLE)
""")
rows = [
    # group with distinct margins -> highest must win
    ("r1", 1, "Combat & Bosses", "Combat & Bosses", "praise",    0.9, 0.7),
    ("r1", 1, "Art & Visuals",   "Combat & Bosses", "complaint", 0.2, -0.4),
    # two keyword arms resolving to the SAME true aspect -> one row out, higher margin wins
    ("r2", 1, "Combat & Bosses", "Art & Visuals",   "praise",    0.3, 0.5),
    ("r2", 1, "Art & Visuals",   "Art & Visuals",   "complaint", 0.8, -0.2),
    # ALL margins NULL (no classifier verdict) -> must SURVIVE and fall back
    ("r3", 2, "Performance",     None,              None,        None, 0.1),
    ("r3", 2, "Performance",     None,              None,        None, 0.1),
    # NULL margin competing against a real one -> real one wins (NULLS LAST)
    ("r4", 2, "Art & Visuals",   "Art & Visuals",   "praise",    None, 0.9),
    ("r4", 2, "Art & Visuals",   "Art & Visuals",   "complaint", 0.4, -0.9),
    # excluded by the NONE filter
    ("r5", 3, "Combat & Bosses", "NONE",            "praise",    0.99, 0.9),
    # single-row group
    ("r6", 3, "Performance",     None,              "complaint", 0.5, -0.5),
]
con.executemany("INSERT INTO m VALUES (?,?,?,?,?,?,?)", rows)
con.execute("CREATE TABLE p(recommendationid VARCHAR, appid INTEGER)")
con.executemany("INSERT INTO p VALUES (?,?)",
                sorted({(r[0], r[1]) for r in rows}))

OLD = """
SELECT appid, recommendationid, aspect, kw_aspect, compound, clf_sentiment FROM (
    SELECT p.appid, m.recommendationid, COALESCE(m.clf_aspect, m.aspect) AS aspect,
           m.clf_sentiment, m.aspect AS kw_aspect, m.compound,
           row_number() OVER (
               PARTITION BY p.appid, m.recommendationid, COALESCE(m.clf_aspect, m.aspect)
               ORDER BY m.clf_margin DESC NULLS LAST) AS rn
    FROM m JOIN p ON p.recommendationid = m.recommendationid
    WHERE m.clf_aspect IS NULL OR m.clf_aspect <> 'NONE'
) WHERE rn = 1
ORDER BY appid, recommendationid, aspect
"""

NEW = """
SELECT appid, recommendationid, aspect, kw_aspect, compound, clf_sentiment FROM (
    SELECT p.appid, m.recommendationid, COALESCE(m.clf_aspect, m.aspect) AS aspect,
           arg_max(m.clf_sentiment, COALESCE(m.clf_margin, -1e30)) AS clf_sentiment,
           arg_max(m.aspect,        COALESCE(m.clf_margin, -1e30)) AS kw_aspect,
           arg_max(m.compound,      COALESCE(m.clf_margin, -1e30)) AS compound
    FROM m JOIN p ON p.recommendationid = m.recommendationid
    WHERE m.clf_aspect IS NULL OR m.clf_aspect <> 'NONE'
    GROUP BY p.appid, m.recommendationid, COALESCE(m.clf_aspect, m.aspect)
)
ORDER BY appid, recommendationid, aspect
"""

old = con.execute(OLD).fetchall()
new = con.execute(NEW).fetchall()

print(f"old rows: {len(old)}   new rows: {len(new)}")
for o, n in zip(old, new):
    mark = "  " if o == n else "??"
    print(f"{mark} old={o}")
    if o != n:
        print(f"   new={n}")
assert len(old) == len(new), f"ROW COUNT DIFFERS: {len(old)} vs {len(new)}"
assert old == new, "CONTENT DIFFERS"

# The r3 group (all-NULL margins) is the one a naive arg_max would silently drop.
assert any(r[1] == "r3" for r in new), "r3 (all-NULL margins) was DROPPED — sentinel failed"
print("\nIDENTICAL — including the all-NULL-margin group that a naive arg_max would drop")
