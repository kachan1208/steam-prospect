import { describe, expect, it } from "vitest";

import {
  DOSSIER_LABEL,
  EMERGING_DEMAND_LABEL,
  RING_COLOR,
  RING_LABEL,
  RING_ORDER,
  SOLO_FRIENDLY_MIN,
  cutPopulationLabel,
  fmtDemandTrend24m,
  radarBoardAbsence,
  radarDossier,
  radarSector,
  radarVerdictTrace,
} from "./radarVerdict";
import { glossary } from "./glossary";
import { MONO } from "./palette";

describe("DOSSIER_LABEL — the glossary's plain names, held without importing the glossary", () => {
  // The Radar is the eager index route and must not ship lib/glossary.ts on first paint, so
  // the board's row labels are plain strings in radarVerdict.ts. This pins them to the
  // glossary's canonical labels so a rename there cannot leave the board behind.
  it("matches the canonical label of every metric it names", () => {
    expect(DOSSIER_LABEL.demand).toBe(glossary("demand_trend_24m_pct").label);
    expect(DOSSIER_LABEL.reviews24m).toBe(glossary("reviews_24m").label);
    expect(DOSSIER_LABEL.releases).toBe(glossary("saturation_yoy").label);
    expect(DOSSIER_LABEL.p90).toBe(glossary("p90_rev").label);
    expect(DOSSIER_LABEL.games).toBe(glossary("n_games").label);
    expect(DOSSIER_LABEL.opportunity).toBe(glossary("opportunity_v2").label);
    expect(DOSSIER_LABEL.singleplayer).toBe(glossary("singleplayer_share").label);
  });

  it("never prints the retired jargon", () => {
    for (const label of Object.values(DOSSIER_LABEL)) expect(label).not.toMatch(/Opp v2|P90|24m\b|YoY/);
  });

  it("names the population a count describes", () => {
    expect(cutPopulationLabel("24m", 50)).toBe("last 24 months · ≥50 reviews");
    expect(cutPopulationLabel("all", 0)).toBe("all time · every game");
    expect(cutPopulationLabel("all", 100)).toBe("all time · ≥100 reviews");
    expect(radarDossier({ n_games: 227, window: "24m", min_reviews: 50 }).population).toBe("last 24 months · ≥50 reviews");
    expect(radarDossier({ n_games: 227 }).population).toBeNull();
  });
});

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
    expect(d.opportunity).toBe("86.7");
    expect(d.singleplayerShare).toBe("98%");
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
    expect(d.opportunity).toBe("—");
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
      "Not on the Radar board: of the community tags it plots only game types and themes, and this tag is a broad genre.",
    );
    expect(radarBoardAbsence({ dimension: "tag", tier: null, solo_viability: 0.99 })).toMatch(/is not sorted into a type yet\.$/);
  });

  it("names the singleplayer filter, with the share and the bar, and how to see the dot anyway", () => {
    const line = radarBoardAbsence({ dimension: "tag", tier: "micro", solo_viability: 0.353 });
    expect(line).toMatch(/singleplayer share 35% is under the 80% bar of the board's “Solo\/indie-friendly” filter/);
    expect(line).toMatch(/with that filter off/);
    expect(line).not.toMatch(/solo-friendly/i); // the lens's old, over-promising name
    expect(radarBoardAbsence({ dimension: "tag", tier: "micro", solo_viability: null })).toMatch(
      /singleplayer share is unknown/,
    );
  });

  it("with the solo/indie evidence it names the studio-dominated reason, in numbers", () => {
    const line = radarBoardAbsence({
      dimension: "tag", tier: "micro", solo_viability: 0.92,
      indie_friendly: false, n_hits_100k: 33, n_small_indie_hits: 8,
    });
    expect(line).toMatch(/8 of 33 of its games over \$100K come from small indie developers/);
    expect(line).toMatch(/Turn the lens off to see it/);
    expect(radarBoardAbsence({ dimension: "tag", tier: "micro", solo_viability: 0.5, indie_friendly: true })).toBeNull();
    expect(
      radarBoardAbsence({ dimension: "tag", tier: "micro", indie_friendly: false, n_hits_100k: 0, n_small_indie_hits: 0 }),
    ).toMatch(/no game here has cleared \$100K yet/);
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
