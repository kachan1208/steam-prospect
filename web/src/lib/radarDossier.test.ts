import { describe, expect, it } from "vitest";

import {
  EMERGING_DEMAND_LABEL,
  RING_COLOR,
  RING_LABEL,
  RING_ORDER,
  SOLO_FRIENDLY_MIN,
  fmtDemandTrend24m,
  radarBoardAbsence,
  radarDossier,
  radarSector,
  radarVerdictTrace,
} from "./radarVerdict";
import { MONO } from "./palette";

/**
 * The niche pages print the Radar tooltip's rows through radarDossier() (2026-09-09). The
 * string FORMATS are pinned here; the equality with the board's actual rendering is pinned
 * in pages/NicheDetail.test.tsx, which hovers a real RadarBoard dot and compares.
 */

const ACTION_RTS = {
  demand_trend_24m_pct: 74.1,
  demand_emerging: false,
  saturation_yoy: -0.074,
  winner_concentration: 0.62,
  opportunity_v2: 86.69,
  entrant_ratio: 1.2,
  solo_viability: 0.98,
  reviews_24m: 120_000,
  reviews_prev_24m: 69_000,
  n_games: 86,
  p90_rev: 9_700_000,
};

describe("radarDossier — the tooltip's rows, as strings", () => {
  it("formats every row the way RadarBoard's tooltip does", () => {
    const d = radarDossier(ACTION_RTS);
    expect(d.verdict.ring).toBe("enter");
    expect(d.verdictLabel).toBe("Enter now");
    expect(d.color).toBe("var(--verdict-enter)");
    expect(d.demand24m).toBe("▲ +74.1%");
    expect(d.releasesYoy).toBe("-7%");
    expect(d.p90Revenue).toBe("$9.7M");
    expect(d.games).toBe("86");
    expect(d.oppV2).toBe("86.7");
    expect(d.singleplayerShare).toBe("0.98");
    expect(d.reviews24m).toBe("120,000");
    expect(d.emerging).toBe(false);
  });

  it("is the SAME evaluation as radarVerdictTrace — ring, caution, reason and checks", () => {
    const d = radarDossier(ACTION_RTS);
    expect(d.verdict).toEqual(radarVerdictTrace(ACTION_RTS));
  });

  it("appends the board's caution suffix to a hedged placement", () => {
    const d = radarDossier({ opportunity_v2: 70, n_games: 40, p90_rev: 100_000 });
    expect(d.verdict.ring).toBe("watch");
    expect(d.verdict.caution).toBe(true);
    expect(d.verdictLabel).toBe("Watch · caution");
    expect(d.demand24m).toBe("no demand data");
    expect(d.releasesYoy).toBe("unknown");
    expect(d.singleplayerShare).toBe("unknown");
  });

  it("never headlines an emerging niche's % — the tooltip phrase and the absolute volume instead", () => {
    const d = radarDossier({
      ...ACTION_RTS,
      demand_emerging: true,
      demand_trend_24m_pct: 4775,
      reviews_24m_new_share: 0.9,
    });
    expect(d.emerging).toBe(true);
    expect(d.verdictLabel).toBe("Emerging");
    expect(d.demand24m).toBe(EMERGING_DEMAND_LABEL);
    expect(d.demand24m).not.toMatch(/4775/);
    expect(d.reviews24m).toBe("120,000");
  });

  it("degrades every unknown to the tooltip's own placeholder, never to 0", () => {
    const d = radarDossier({});
    expect(d.p90Revenue).toBe("—");
    expect(d.games).toBe("—");
    expect(d.oppV2).toBe("—");
    expect(d.reviews24m).toBeNull();
  });

  it("fmtDemandTrend24m signs and glyphs exactly like the board", () => {
    expect(fmtDemandTrend24m(0)).toBe("▲ +0.0%");
    expect(fmtDemandTrend24m(-16)).toBe("▼ −16.0%");
    expect(fmtDemandTrend24m(196.04)).toBe("▲ +196.0%");
    expect(fmtDemandTrend24m(null)).toBe("no demand data");
    expect(fmtDemandTrend24m(Number.NaN)).toBe("no demand data");
  });
});

describe("RING_COLOR — the board's colour tokens, one per legend word", () => {
  it("covers every ring in legend order with the index.css verdict tokens (watch = neutral steel)", () => {
    expect(RING_ORDER.map((r) => RING_COLOR[r])).toEqual([
      "var(--verdict-enter)",
      MONO.paper75,
      "var(--verdict-emerging)",
      "var(--verdict-crowded)",
      "var(--verdict-declining)",
    ]);
    for (const ring of RING_ORDER) expect(RING_LABEL[ring]).toBeTruthy();
  });
});

describe("radarBoardAbsence — why a niche has no dot on the default board", () => {
  it("is null for a solo-friendly micro/theme tag or a genre — the board's population", () => {
    expect(radarBoardAbsence({ dimension: "tag", tier: "micro", solo_viability: 0.98 })).toBeNull();
    expect(radarBoardAbsence({ dimension: "tag", tier: "theme", solo_viability: SOLO_FRIENDLY_MIN })).toBeNull();
    expect(radarBoardAbsence({ dimension: "genre", tier: null, solo_viability: 0.9 })).toBeNull();
  });

  it("names the class rule for umbrella/meta/untiered tags", () => {
    expect(radarBoardAbsence({ dimension: "tag", tier: "umbrella", solo_viability: 0.99 })).toBe(
      "Not on the Radar board: it plots micro-genre and theme tags only, and this tag is umbrella tier.",
    );
    expect(radarBoardAbsence({ dimension: "tag", tier: null, solo_viability: 0.99 })).toMatch(/is untiered\.$/);
  });

  it("names the solo filter, with the share and the bar, and how to see the dot anyway", () => {
    const line = radarBoardAbsence({ dimension: "tag", tier: "micro", solo_viability: 0.353 });
    expect(line).toMatch(/singleplayer share 0\.35 is under the 0\.8 solo-friendly bar/);
    expect(line).toMatch(/Solo-friendly only/);
    expect(radarBoardAbsence({ dimension: "tag", tier: "micro", solo_viability: null })).toMatch(
      /singleplayer share is unknown/,
    );
  });

  it("radarSector mirrors Radar.tsx's pool rule", () => {
    expect(radarSector("genre", null)).toBe("genre");
    expect(radarSector("tag", "micro")).toBe("micro");
    expect(radarSector("tag", "theme")).toBe("theme");
    expect(radarSector("tag", "umbrella")).toBeNull();
    expect(radarSector("tag", "meta")).toBeNull();
    expect(radarSector("tag", undefined)).toBeNull();
  });
});
