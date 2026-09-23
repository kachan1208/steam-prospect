"""`scope=indie` — the indie-first population filter, defined once.

The defaults a solo developer lands on were useless as comparables: a niche's top games
led with Monster Hunter Wilds ($695M) and ELDEN RING NIGHTREIGN, /games opened on CS:GO and
Dota 2, /studios on EA / Bandai Namco / Ubisoft. `scope=indie` narrows those lists; the API
default stays `all` (the web picks its own default).

GAMES: mart_game.is_indie = 1 — Steam's own "Indie" genre flag, which the developer sets on
the store page (as captured by the catalog's analysis snapshot). NULL is UNKNOWN (a game
added after that snapshot — about half of the last 90 days' releases on the 2026-09-21
mart), and unknown is not indie: those games are excluded, and every scoped response
COUNTS them (n_scope_unknown) so the exclusion is never silent.

Why not "self-published OR indie-flagged" (the first proposal): self-publishing is not a
size signal. Valve (CS:GO, Dota 2), Capcom (Monster Hunter Wilds), CD PROJEKT, Rockstar and
Larian all self-publish, so the OR keeps exactly the comparables the scope exists to remove.
Checked on the real mart: every one of those titles carries is_indie = 0.
`self_published` stays available as its own filter.

ENTITIES (developers / publishers): at least half of the entity's games that carry a known
flag are Indie-flagged — AVG(is_indie) >= ENTITY_INDIE_MIN_SHARE over mart_entity_games x
mart_game. EA, Bandai Namco, Ubisoft and Capcom fall out; Devolver, Team17, Klei and
Supergiant stay. An entity with no flagged game at all is unknown: excluded, and counted.
"""
from __future__ import annotations

from typing import Literal

Scope = Literal["all", "indie"]

SCOPE_DESC = (
    "Population scope. all (default) = every game. indie = Steam's Indie-flagged games only "
    "(mart_game.is_indie = 1; unknown flags are excluded and counted in n_scope_unknown). "
    "Self-publishing alone is NOT indie: Valve, Capcom and CD PROJEKT self-publish."
)

ENTITY_SCOPE_DESC = (
    "Population scope. all (default) = every developer/publisher. indie = entities at least "
    "half of whose flagged games are Steam Indie-flagged (AVG(is_indie) >= 0.5); entities "
    "with no flagged game are excluded and counted in n_scope_unknown."
)

ENTITY_INDIE_MIN_SHARE = 0.5


def game_condition(alias: str = "") -> str:
    """SQL predicate for 'this game is in the indie scope' (alias = table alias + '.')."""
    return f"{alias}is_indie = 1"


def game_unknown(alias: str = "") -> str:
    """SQL predicate for 'this game's indie flag is unknown'."""
    return f"{alias}is_indie IS NULL"
