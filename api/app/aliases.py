"""Tag / genre aliases (mart_tag_alias), capability-gated.

Steam carries several spellings of one niche ("Rogue-like" / "Roguelike", "Rogue-lite" /
"Roguelite", ...), and the ETL now publishes mart_tag_alias(dimension, alias, canonical) so
the product can treat each group as ONE niche. Until the mart carries the table every
function here is the identity — the API behaves exactly as before.

  resolve()   a niche endpoint's (dimension, key) -> the canonical key to serve, plus
              whether an alias was resolved (the web replaces the URL with the canonical)
  variants()  a canonical key -> itself + every alias, for filters that match raw member
              tags (a game tagged only "Rogue-like" is in the Roguelike niche)

The alias table is small (a few hundred rows at most) and is read once per mart generation
(analytics_db.memo), so resolution costs a dict lookup.
"""
from __future__ import annotations

from . import analytics_db

_MAX_HOPS = 5  # an alias of an alias resolves too; a cycle in the data can't loop forever


def has_aliases() -> bool:
    return analytics_db.has_table("mart_tag_alias")


def alias_map() -> dict[tuple[str, str], str]:
    """{(dimension, alias): canonical}; empty when the mart predates mart_tag_alias.
    Self-mappings (alias == canonical) are dropped: they resolve to themselves anyway."""
    if not has_aliases():
        return {}

    def compute() -> dict[tuple[str, str], str]:
        rows = analytics_db.query("SELECT dimension, alias, canonical FROM mart_tag_alias")
        return {
            (str(r["dimension"]), str(r["alias"])): str(r["canonical"])
            for r in rows
            if r["dimension"] is not None and r["alias"] is not None
            and r["canonical"] is not None and r["alias"] != r["canonical"]
        }

    return analytics_db.memo("aliases.map", compute)


def resolve(dimension: str, key: str) -> tuple[str, str | None]:
    """(canonical key, alias_of). alias_of is the canonical key when `key` WAS an alias,
    None when `key` is already canonical (or the mart has no alias table)."""
    amap = alias_map()
    current = key
    for _ in range(_MAX_HOPS):
        nxt = amap.get((dimension, current))
        if nxt is None or nxt == current:
            break
        current = nxt
    return (current, current) if current != key else (key, None)


def variants(dimension: str, key: str) -> list[str]:
    """The canonical of `key` followed by every alias that resolves to it."""
    canonical, _ = resolve(dimension, key)
    extra = sorted(
        alias for (dim, alias) in alias_map()
        if dim == dimension and alias != canonical and resolve(dim, alias)[0] == canonical
    )
    return [canonical, *extra]
