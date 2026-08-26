import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { RadarBoard, type RadarBoardBlip } from "./RadarBoard";
import { SOLO_FRIENDLY_MIN, radarVerdictTrace, type RadarVerdictInput } from "../lib/radarVerdict";

/**
 * Two surfaces are pinned here:
 *
 * 1. THE POPULATION LEGEND. With `soloOnly` the board's population is server-filtered to
 *    solo-friendly niches, so the legend must STATE the population rule (threshold
 *    included) instead of drawing the hollow/filled lens samples — the UI must never
 *    imply team-scale niches might be hiding on the board. With the toggle off, the full
 *    population returns and the lens samples come back.
 *
 * 2. THE VERDICT DOSSIER. Clicking a dot opens the per-niche analysis panel: the
 *    verdict-trace rows (check label, the niche's number, the bar, pass/fail) from the
 *    SAME radarVerdictTrace evaluation that placed the dot, plus the deep-dive link.
 */

function makeBlip(key: string, input: RadarVerdictInput, over: Partial<RadarBoardBlip> = {}): RadarBoardBlip {
  const { checks, ...verdict } = radarVerdictTrace(input);
  return {
    dimension: "tag",
    key,
    tier: "micro",
    sector: "micro",
    n_games: 41,
    p90_rev: 612_000,
    opportunity_v2: input.opportunity_v2 ?? 80,
    demandTrendPct: input.demand_trend_24m_pct ?? null,
    demandEmerging: input.demand_emerging === true,
    reviews24m: input.reviews_24m ?? null,
    reviewsPrev24m: input.reviews_prev_24m ?? null,
    solo_viability: input.solo_viability ?? null,
    verdict,
    trace: checks,
    ...over,
  };
}

// The user's reference analysis shape (Roguelike Deckbuilder): top solo-buildable, demand
// far past the enter bar, but supply flooding — watch, with two falsification tells.
const REFERENCE: RadarVerdictInput = {
  demand_trend_24m_pct: 196,
  reviews_24m: 604_000,
  reviews_prev_24m: 204_700,
  saturation_yoy: 0.409,
  winner_concentration: 0.836,
  entrant_ratio: 0.843,
  opportunity_v2: 71.2,
  solo_viability: 0.995,
};

function renderBoard(blips: RadarBoardBlip[], soloOnly: boolean) {
  return render(
    <MemoryRouter>
      <RadarBoard blips={blips} soloOnly={soloOnly} />
    </MemoryRouter>,
  );
}

afterEach(cleanup);

describe("RadarBoard — population legend", () => {
  it("soloOnly states the population rule with the threshold, and drops the lens samples", () => {
    renderBoard([makeBlip("Roguelike Deckbuilder", REFERENCE)], true);
    const rule = screen.getByText(new RegExp(`population: solo-friendly only · solo viability ≥ ${SOLO_FRIENDLY_MIN}`));
    expect(rule.textContent).toContain("unknown");
    expect(rule.textContent).toContain("excluded");
    // No hollow/team sample may imply team-scale niches could be present.
    expect(screen.queryByText(/team-scale/)).toBeNull();
  });

  it("with the toggle off the lens samples return (hollow = team-scale)", () => {
    renderBoard([makeBlip("Roguelike Deckbuilder", REFERENCE)], false);
    expect(screen.getByText(new RegExp(`team-scale \\(< ${SOLO_FRIENDLY_MIN}\\)`))).toBeTruthy();
    expect(screen.queryByText(/population: solo-friendly only/)).toBeNull();
  });

  it("the empty state names the population when solo-only", () => {
    renderBoard([], true);
    expect(screen.getByText("No solo-friendly niches match this cut.")).toBeTruthy();
    cleanup();
    renderBoard([], false);
    expect(screen.getByText("No niches match this cut.")).toBeTruthy();
  });
});

describe("RadarBoard — verdict dossier", () => {
  it("clicking a dot opens the dossier with the verdict sentence and the trace rows", () => {
    renderBoard([makeBlip("Roguelike Deckbuilder", REFERENCE)], true);
    expect(screen.queryByTestId("verdict-dossier")).toBeNull();

    fireEvent.click(screen.getByTestId("radar-blip-tag:Roguelike Deckbuilder"));
    const dossier = screen.getByTestId("verdict-dossier");
    // The one-line verdict sentence — the ring is explained, not just asserted.
    expect(dossier.textContent).toContain("Watch");
    expect(dossier.textContent).toContain("demand surging, but supply flooding");
    // The trace rows: the niche's own numbers next to the bars they were judged against.
    expect(dossier.textContent).toContain("Demand");
    expect(dossier.textContent).toContain("+196.0% / 24m");
    expect(dossier.textContent).toContain("bar ≥ +40.0% / 24m to enter");
    expect(dossier.textContent).toContain("+40.9% releases YoY");
    expect(dossier.textContent).toContain("supply flooding — vetoes enter");
    // The falsification tells, labeled as context (they never move the ring).
    expect(dossier.textContent).toContain("Newcomer economics · context");
    expect(dossier.textContent).toContain("16% below the niche median");
    expect(dossier.textContent).toContain("a hair under the winner-take-most bar");
    // The solo lens row keeps the raw score visible.
    expect(dossier.textContent).toContain("Solo viability · context");
    expect(dossier.textContent).toContain("0.99");
    // Raw context numbers + the deep-dive link.
    expect(dossier.textContent).toContain("reviews 24m 604,000");
    expect(dossier.textContent).toContain("prior 24m 204,700");
    const link = screen.getByRole("link", { name: /open deep dive/i });
    expect(link.getAttribute("href")).toContain("Roguelike");
  });

  it("closes on the close button", () => {
    renderBoard([makeBlip("Roguelike Deckbuilder", REFERENCE)], true);
    fireEvent.click(screen.getByTestId("radar-blip-tag:Roguelike Deckbuilder"));
    expect(screen.getByTestId("verdict-dossier")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /close dossier/i }));
    expect(screen.queryByTestId("verdict-dossier")).toBeNull();
  });

  it("an emerging niche's dossier shows volume + new-game share, never the trend %", () => {
    const emerging = makeBlip("Organizing", {
      demand_emerging: true,
      demand_trend_24m_pct: 4850,
      reviews_24m: 39_600,
      reviews_24m_new_share: 0.94,
      solo_viability: 0.94,
    });
    renderBoard([emerging], true);
    fireEvent.click(screen.getByTestId("radar-blip-tag:Organizing"));
    const dossier = screen.getByTestId("verdict-dossier");
    expect(dossier.textContent).toContain("Emerging");
    expect(dossier.textContent).toContain("39.6K reviews / 24m");
    expect(dossier.textContent).toContain("94% from games ≤ 24m old");
    // A young tag's % has no comparable base — it must not appear anywhere in the panel.
    expect(dossier.textContent).not.toContain("4850");
    expect(dossier.textContent).not.toContain("4,850");
  });
});
