import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import {
  PLOT,
  RadarBoard,
  layoutXY,
  xToPx,
  yToPx,
  type RadarBoardBlip,
} from "./RadarBoard";
import {
  SOLO_FRIENDLY_MIN,
  radarVerdictTrace,
  type RadarVerdictInput,
} from "../lib/radarVerdict";

/**
 * Pinned here:
 *
 * 1. THE POPULATION LEGEND. With `soloOnly` the board's population is server-filtered to
 *    solo-friendly niches, so the legend must STATE the population rule (threshold
 *    included) instead of drawing the hollow/filled lens samples — and it must name the
 *    metric honestly: "singleplayer share", never bare "solo viability".
 *
 * 2. THE VERDICT DOSSIER + SELECTION MODEL. Selection is controlled (selectedId/onSelect);
 *    clicking a dot or its rail row opens the per-niche dossier IN THE RAIL: the
 *    verdict-trace rows from the SAME radarVerdictTrace evaluation that placed the dot,
 *    the solo row's inline member evidence, and the deep-dive link.
 *
 * 3. CLICK-TARGET HYGIENE (A4). Only blip dots are interactive inside the SVG — the
 *    axes/threshold decor and the legend's sample circles must never open a dossier.
 *
 * 4. NO SILENT CAPS (A1). The rail renders EVERY entry of every ring group, and the group
 *    headers carry the full counts.
 *
 * 5. THE XY QUADRANT PLATE (2026-08-27 directive). The quadrant lines sit at the
 *    verdict's own thresholds (+40%/24m demand, +15% YoY flood), axes carry units,
 *    beyond-domain values pin at the plot edge with an explicit chevron (never dropped,
 *    never fake-positioned), and emerging / no-trend rows live in the dashed strip below
 *    the plot. layoutXY is deterministic call-to-call, coincident-dot jitter included.
 *
 * 6. NICHE SEARCH OVER THE FULL POOL (2026-08-27 directive). The rail search filters the
 *    WHOLE population (`pool` prop), not just the plotted Top-N: a beyond-plot match
 *    appears (dash rank), opens a full dossier with the honest "beyond the Top N plot"
 *    note, a plotted match never carries that note, zero matches get an honest empty row
 *    naming the searched population, and Esc clears back to the plotted list.
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
    saturationYoy: input.saturation_yoy ?? null,
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

/** Selection is controlled by the page — the harness stands in for it. `pool` defaults
 * to the plotted blips (the common case in these tests); the search suite passes a
 * strictly larger pool to pin the beyond-plot behavior. */
function Harness({
  blips,
  soloOnly,
  pool,
  plotCap,
}: {
  blips: RadarBoardBlip[];
  soloOnly: boolean;
  pool?: RadarBoardBlip[];
  plotCap?: number;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  return (
    <MemoryRouter>
      <RadarBoard
        blips={blips}
        pool={pool ?? blips}
        plotCap={plotCap ?? blips.length}
        soloOnly={soloOnly}
        selectedId={selectedId}
        onSelect={setSelectedId}
      />
    </MemoryRouter>
  );
}

function renderBoard(
  blips: RadarBoardBlip[],
  soloOnly: boolean,
  extra: { pool?: RadarBoardBlip[]; plotCap?: number } = {},
) {
  return render(<Harness blips={blips} soloOnly={soloOnly} pool={extra.pool} plotCap={extra.plotCap} />);
}

afterEach(cleanup);

describe("RadarBoard — population legend", () => {
  it("soloOnly states the population rule with the honest metric name, and drops the lens samples", () => {
    renderBoard([makeBlip("Roguelike Deckbuilder", REFERENCE)], true);
    const rule = screen.getByText(
      new RegExp(`population: solo-friendly only · singleplayer share ≥ ${SOLO_FRIENDLY_MIN}`),
    );
    expect(rule.textContent).toContain("unknown");
    expect(rule.textContent).toContain("excluded");
    // No hollow/team sample may imply team-scale niches could be present.
    expect(screen.queryByText(/team-scale/)).toBeNull();
  });

  it("with the toggle off the lens samples return (hollow = team-scale), still named honestly", () => {
    renderBoard([makeBlip("Roguelike Deckbuilder", REFERENCE)], false);
    expect(screen.getByText(new RegExp(`team-scale \\(< ${SOLO_FRIENDLY_MIN}\\)`))).toBeTruthy();
    expect(screen.getByText(new RegExp(`singleplayer share ≥ ${SOLO_FRIENDLY_MIN}`))).toBeTruthy();
    expect(screen.queryByText(/population: solo-friendly only/)).toBeNull();
  });

  it("the metric is never labeled with the dishonest bare name", () => {
    const { container } = renderBoard([makeBlip("Roguelike Deckbuilder", REFERENCE)], true);
    expect(container.textContent).not.toMatch(/solo viability/i);
  });

  it("the empty state names the population when solo-only", () => {
    renderBoard([], true);
    expect(screen.getByText("No solo-friendly niches match this cut.")).toBeTruthy();
    cleanup();
    renderBoard([], false);
    expect(screen.getByText("No niches match this cut.")).toBeTruthy();
  });
});

describe("RadarBoard — verdict dossier (rail selection mode)", () => {
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
    // The solo lens row keeps the raw score visible, under the honest metric name.
    expect(dossier.textContent).toContain("Solo evidence · context");
    expect(dossier.textContent).toContain("0.99 singleplayer");
    expect(dossier.textContent).toContain(`bar ≥ ${SOLO_FRIENDLY_MIN} singleplayer share`);
    // Raw context numbers + the deep-dive link.
    expect(dossier.textContent).toContain("reviews 24m 604,000");
    expect(dossier.textContent).toContain("prior 24m 204,700");
    const link = screen.getByRole("link", { name: /open deep dive/i });
    expect(link.getAttribute("href")).toContain("Roguelike");
  });

  it("clicking a rail row opens the same dossier (rows and dots share the selection)", () => {
    renderBoard([makeBlip("Roguelike Deckbuilder", REFERENCE)], true);
    fireEvent.click(screen.getByTestId("radar-row-tag:Roguelike Deckbuilder"));
    expect(screen.getByTestId("verdict-dossier").textContent).toContain("Roguelike Deckbuilder");
  });

  it("the dossier replaces the rail list and the back affordance restores it", () => {
    renderBoard([makeBlip("Roguelike Deckbuilder", REFERENCE)], true);
    expect(screen.getByTestId("radar-rail-list")).toBeTruthy();
    fireEvent.click(screen.getByTestId("radar-blip-tag:Roguelike Deckbuilder"));
    expect(screen.queryByTestId("radar-rail-list")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /back to all verdicts/i }));
    expect(screen.queryByTestId("verdict-dossier")).toBeNull();
    expect(screen.getByTestId("radar-rail-list")).toBeTruthy();
  });

  it("renders the solo member evidence inline when the mart serves it", () => {
    // The user's motivating case: Souls-like's 0.98 singleplayer share is honest only
    // next to WHO the members are — 50% self-published, 71% indie, median 5.7h content.
    const soulsLike = makeBlip("Souls-like", {
      ...REFERENCE,
      solo_viability: 0.98,
      self_published_share: 0.5,
      indie_share: 0.71,
      med_playtime_h: 5.7,
    });
    renderBoard([soulsLike], true);
    fireEvent.click(screen.getByTestId("radar-blip-tag:Souls-like"));
    const dossier = screen.getByTestId("verdict-dossier");
    expect(dossier.textContent).toContain("0.98 singleplayer · 50% self-pub · 71% indie · median 5.7h content");
    // 5.7h median is NOT heavy content — no scope caution.
    expect(dossier.textContent).not.toContain("heavy content scope");
  });

  it("carries the neutral heavy-content caution when the median member offers 20+ hours", () => {
    const heavy = makeBlip("Colony Sim", {
      ...REFERENCE,
      solo_viability: 0.97,
      self_published_share: 0.61,
      indie_share: 0.83,
      med_playtime_h: 24.3,
    });
    renderBoard([heavy], true);
    fireEvent.click(screen.getByTestId("radar-blip-tag:Colony Sim"));
    const dossier = screen.getByTestId("verdict-dossier");
    expect(dossier.textContent).toContain("median 24.3h content");
    expect(dossier.textContent).toContain("heavy content scope for a solo build");
    // Neutral: the row still PASSES the singleplayer bar and the ring is untouched.
    expect(dossier.textContent).toContain("Watch");
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

describe("RadarBoard — click-target hygiene (A4)", () => {
  it("clicking the axis/threshold decor never opens a dossier", () => {
    renderBoard([makeBlip("Roguelike Deckbuilder", REFERENCE)], true);
    // The decor group (frame, zero lines, threshold bars, labels) is pointer-inert as a
    // GROUP, so a misaimed or scripted click on a hairline can never read as a dead dot.
    expect(screen.getByTestId("xy-decor").getAttribute("pointer-events")).toBe("none");
    fireEvent.click(screen.getByTestId("xy-bar-demand"));
    fireEvent.click(screen.getByTestId("xy-bar-flood"));
    expect(screen.queryByTestId("verdict-dossier")).toBeNull();
  });

  it("the legend sample circles are aria-hidden glyphs, not click targets", () => {
    const { container } = renderBoard([makeBlip("Roguelike Deckbuilder", REFERENCE)], false);
    const sampleSvgs = Array.from(container.querySelectorAll("div svg[aria-hidden]")).filter(
      (s) => s.getAttribute("width") !== null, // the tiny inline legend glyphs
    );
    expect(sampleSvgs.length).toBeGreaterThan(0);
    for (const svg of sampleSvgs) {
      expect(svg.classList.contains("pointer-events-none")).toBe(true);
      fireEvent.click(svg.querySelector("circle")!);
    }
    expect(screen.queryByTestId("verdict-dossier")).toBeNull();
  });
});

describe("RadarBoard — rail list has no silent caps (A1)", () => {
  it("renders every entry of a large ring group and the header carries the full count", () => {
    const blips = Array.from({ length: 46 }, (_, i) =>
      // demand +10% => "watch / demand holding" for every one of them.
      makeBlip(`Watch Niche ${String(i).padStart(2, "0")}`, { demand_trend_24m_pct: 10, opportunity_v2: 50 - i / 10 }),
    );
    renderBoard(blips, true);
    // Every row is really in the DOM — no “…up to #22” truncation.
    for (const b of blips) {
      expect(screen.getByTestId(`radar-row-tag:${b.key}`)).toBeTruthy();
    }
    // The rail header and the Watch group header both state the full count. ("Watch" also
    // paints inside the SVG ring names, so scope the group check to the rail list.)
    expect(screen.getByText("Verdicts").parentElement?.textContent).toContain("46");
    const rail = screen.getByTestId("radar-rail-list");
    const watchHeader = Array.from(rail.querySelectorAll("span")).find((s) => s.textContent === "Watch");
    expect(watchHeader?.parentElement?.textContent).toContain("46");
  });
});

describe("RadarBoard — niche search over the full pool", () => {
  // Two plotted niches + one that only exists in the pool (beyond the Top-2 plot cap).
  const plotted = [
    makeBlip("Roguelike Deckbuilder", REFERENCE),
    makeBlip("City Builder", { demand_trend_24m_pct: 10, opportunity_v2: 60 }),
  ];
  const beyond = makeBlip("Cozy Fishing", { demand_trend_24m_pct: 12, opportunity_v2: 9 });
  const pool = [...plotted, beyond];
  const setup = () => renderBoard(plotted, true, { pool, plotCap: 2 });
  const search = () => screen.getByTestId("radar-search") as HTMLInputElement;
  const type = (value: string) => fireEvent.change(search(), { target: { value } });

  it("filters live over the FULL pool (case-insensitive substring), not just the plotted dots", () => {
    setup();
    // Default list = the plotted Top-N; the beyond-plot niche is not a row yet.
    expect(screen.getByTestId("radar-row-tag:City Builder")).toBeTruthy();
    expect(screen.queryByTestId("radar-row-tag:Cozy Fishing")).toBeNull();
    // The scope is stated up front: the input names the whole pool.
    expect(search().getAttribute("placeholder")).toContain("all 3 niches");

    type("cOzY");
    expect(screen.getByTestId("radar-row-tag:Cozy Fishing")).toBeTruthy();
    expect(screen.queryByTestId("radar-row-tag:City Builder")).toBeNull();
    expect(screen.queryByTestId("radar-row-tag:Roguelike Deckbuilder")).toBeNull();
    // The header carries the honest match arithmetic over the searched population.
    expect(screen.getByText("1 of 3 match")).toBeTruthy();
    // No dot exists for it, so the row shows a dash rank, never a fake number.
    expect(screen.getByTestId("radar-row-tag:Cozy Fishing").textContent).toContain("—");
  });

  it("selecting a beyond-plot search hit opens a full dossier with the honest not-plotted note", () => {
    setup();
    type("fishing");
    fireEvent.click(screen.getByTestId("radar-row-tag:Cozy Fishing"));
    const dossier = screen.getByTestId("verdict-dossier");
    expect(dossier.textContent).toContain("Cozy Fishing");
    expect(dossier.textContent).toContain("Beyond the Top 2 plot");
    // Still a full dossier: trace rows and the deep-dive link are all there.
    expect(dossier.textContent).toContain("bar");
    expect(screen.getByRole("link", { name: /open deep dive/i })).toBeTruthy();
  });

  it("a plotted search hit opens its dossier withOUT the not-plotted note", () => {
    setup();
    type("roguelike");
    fireEvent.click(screen.getByTestId("radar-row-tag:Roguelike Deckbuilder"));
    const dossier = screen.getByTestId("verdict-dossier");
    expect(dossier.textContent).toContain("Roguelike Deckbuilder");
    expect(dossier.textContent).not.toContain("Beyond the Top");
  });

  it("zero matches render an honest empty row naming the searched population", () => {
    setup();
    type("zzz-not-a-niche");
    const empty = screen.getByTestId("radar-search-empty");
    expect(empty.textContent).toContain("No niches match");
    expect(empty.textContent).toContain("searched all 3 niches");
    // No ring group headers linger behind the empty state.
    expect(screen.queryByTestId(/^radar-row-/)).toBeNull();
  });

  it("Escape clears the query and restores the plotted list", () => {
    setup();
    type("cozy");
    expect(screen.getByTestId("radar-row-tag:Cozy Fishing")).toBeTruthy();
    fireEvent.keyDown(search(), { key: "Escape" });
    expect(search().value).toBe("");
    expect(screen.queryByTestId("radar-row-tag:Cozy Fishing")).toBeNull();
    expect(screen.getByTestId("radar-row-tag:City Builder")).toBeTruthy();
  });

  it("Enter opens the first match; arrow keys walk the result rows", () => {
    setup();
    type("fishing");
    fireEvent.keyDown(search(), { key: "Enter" });
    expect(screen.getByTestId("verdict-dossier").textContent).toContain("Cozy Fishing");
    // Back to the list — the query survives the round trip.
    fireEvent.click(screen.getByRole("button", { name: /back to all verdicts/i }));
    expect(search().value).toBe("fishing");

    // Both -builder niches match; ↓ moves the cursor to the second before Enter.
    type("builder");
    fireEvent.keyDown(search(), { key: "ArrowDown" });
    fireEvent.keyDown(search(), { key: "Enter" });
    expect(screen.getByTestId("verdict-dossier").textContent).toContain("City Builder");
  });
});

describe("RadarBoard — XY quadrant plate", () => {
  it("draws the quadrant lines at the verdict's own thresholds, labeled, with axis units", () => {
    renderBoard([makeBlip("Roguelike Deckbuilder", REFERENCE)], true);
    // The vertical bar IS the enter demand bar; the horizontal IS the flood bar.
    const demandBar = screen.getByTestId("xy-bar-demand");
    expect(Number(demandBar.getAttribute("x1"))).toBeCloseTo(xToPx(40), 4);
    const floodBar = screen.getByTestId("xy-bar-flood");
    expect(Number(floodBar.getAttribute("y1"))).toBeCloseTo(yToPx(15), 4);
    expect(screen.getByText(/ENTER BAR \+40% \/ 24M/)).toBeTruthy();
    expect(screen.getByText(/FLOOD BAR \+15% YOY/)).toBeTruthy();
    // Quadrant micro-labels name REGIONS, never the verdict (a growing-open dot can
    // still be Watch on a concentration veto — the dot style owns the final word).
    for (const label of ["GROWING · OPEN", "GROWING · FLOODING", "SHRINKING · FLOODING", "FLAT/SHRINKING · OPEN"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    // Axis titles carry the units — and the Y title states the flipped direction.
    expect(screen.getByText(/DEMAND TREND · % \/ 24M/)).toBeTruthy();
    expect(screen.getByText(/RELEASES YOY · % — CALMER ↑ · FLOODING ↓/)).toBeTruthy();
  });

  it("runs calmer-up: the focus zone is the TOP-RIGHT quadrant, washed in the enter hue", () => {
    // The scale itself: min saturation (calmest) maps to the TOP edge, max to the bottom.
    expect(yToPx(-60)).toBeCloseTo(PLOT.t, 6);
    expect(yToPx(120)).toBeCloseTo(PLOT.t + PLOT.h, 6);

    renderBoard([makeBlip("Roguelike Deckbuilder", REFERENCE)], true);
    // GROWING · OPEN sits top-right (right of the enter bar, above the flood bar)…
    const focus = screen.getByText("GROWING · OPEN");
    expect(Number(focus.getAttribute("x"))).toBeGreaterThan(xToPx(40));
    expect(Number(focus.getAttribute("y"))).toBeLessThan(yToPx(15));
    // …its counterpart GROWING · FLOODING sits below the flood bar…
    expect(Number(screen.getByText("GROWING · FLOODING").getAttribute("y"))).toBeGreaterThan(yToPx(15));
    // …and the low-alpha focus wash covers exactly that quadrant.
    const wash = screen.getByTestId("xy-focus-wash");
    expect(Number(wash.getAttribute("x"))).toBeCloseTo(xToPx(40), 4);
    expect(Number(wash.getAttribute("y"))).toBeCloseTo(PLOT.t, 4);
    expect(Number(wash.getAttribute("width"))).toBeCloseTo(PLOT.l + PLOT.w - xToPx(40), 4);
    expect(Number(wash.getAttribute("height"))).toBeCloseTo(yToPx(15) - PLOT.t, 4);
  });

  it("pins a beyond-scale outlier at the plot edge with a chevron and a ≥ edge tick", () => {
    renderBoard(
      [
        makeBlip("Runaway", { demand_trend_24m_pct: 900, saturation_yoy: 43, opportunity_v2: 50 }),
        makeBlip("Roguelike Deckbuilder", REFERENCE),
      ],
      true,
    );
    // The outlier renders (never dropped) with the explicit beyond-scale marker…
    expect(screen.getByTestId("radar-blip-tag:Runaway")).toBeTruthy();
    expect(screen.getByTestId("radar-clamp-tag:Runaway")).toBeTruthy();
    // …and the edge tick labels admit the scale ends before the data does.
    expect(screen.getByText("≥ +300")).toBeTruthy();
    expect(screen.getByText("≥ +120")).toBeTruthy();
    // The in-domain dot carries no marker.
    expect(screen.queryByTestId("radar-clamp-tag:Roguelike Deckbuilder")).toBeNull();
  });

  it("renders emerging / no-trend rows in the dashed strip with an honest label", () => {
    renderBoard(
      [
        makeBlip("Organizing", { demand_emerging: true, demand_trend_24m_pct: 4850, reviews_24m: 39_600, saturation_yoy: 0.2 }),
        makeBlip("Quiet Niche", { saturation_yoy: 0.1, opportunity_v2: 40 }),
        makeBlip("Roguelike Deckbuilder", REFERENCE),
      ],
      true,
    );
    expect(screen.getByTestId("xy-strip")).toBeTruthy();
    // A no-trend (non-emerging) resident means the label must not claim they are all
    // emerging labels.
    expect(screen.getByText(/EMERGING \/ NO TREND BASE — not plottable · sized by 24m volume/)).toBeTruthy();
    // Strip dots stay first-class: clickable into a dossier like any other.
    fireEvent.click(screen.getByTestId("radar-blip-tag:Quiet Niche"));
    expect(screen.getByTestId("verdict-dossier").textContent).toContain("Quiet Niche");
  });

  it("labels the strip as EMERGING when every resident carries the mart's emerging flag", () => {
    renderBoard(
      [
        makeBlip("Organizing", { demand_emerging: true, demand_trend_24m_pct: 4850, reviews_24m: 39_600, saturation_yoy: 0.2 }),
        makeBlip("Roguelike Deckbuilder", REFERENCE),
      ],
      true,
    );
    expect(screen.getByText(/^EMERGING — no % base · sized by 24m volume$/)).toBeTruthy();
  });
});

describe("layoutXY — deterministic, honest placement", () => {
  const at = (key: string, demand: number, sat: number, over: Partial<RadarBoardBlip> = {}) =>
    makeBlip(key, { demand_trend_24m_pct: demand, saturation_yoy: sat, opportunity_v2: 50 }, over);

  it("positions in-domain dots at their true axis coordinates", () => {
    const { dots } = layoutXY([at("A", 100, 0.3)]);
    expect(dots[0].strip).toBe(false);
    expect(dots[0].clampX).toBe(0);
    expect(dots[0].clampY).toBe(0);
    expect(dots[0].x).toBeCloseTo(xToPx(100), 4);
    expect(dots[0].y).toBeCloseTo(yToPx(30), 4); // fraction 0.3 -> +30% YoY
  });

  it("clamps beyond-domain values to the plot edge and flags them — never drops them", () => {
    const { dots } = layoutXY([at("Hot", 900, 43)]);
    const d = dots[0];
    expect(d.strip).toBe(false);
    expect(d.clampX).toBe(1);
    expect(d.clampY).toBe(1);
    expect(d.x).toBeCloseTo(PLOT.l + PLOT.w - d.r - 1, 4);
    // Calmer-up: flooding beyond the scale pins at the BOTTOM edge.
    expect(d.y).toBeCloseTo(PLOT.t + PLOT.h - d.r - 1, 4);
  });

  it("sends emerging and no-XY rows to the strip below the plot — no fake quadrant position", () => {
    const layout = layoutXY([
      makeBlip("Young", { demand_emerging: true, demand_trend_24m_pct: 4850, reviews_24m: 10_000, saturation_yoy: 0.2 }),
      makeBlip("No Trend", { saturation_yoy: 0.1 }),
      makeBlip("No Sat", { demand_trend_24m_pct: 50 }),
    ]);
    expect(layout.stripCount).toBe(3);
    expect(layout.stripHasNonEmerging).toBe(true);
    for (const d of layout.dots) {
      expect(d.strip).toBe(true);
      expect(d.y).toBeGreaterThan(PLOT.t + PLOT.h); // below the plot box, inside the strip
    }
    // The viewBox grows for the strip instead of overlaying the axis.
    expect(layout.vbH).toBeGreaterThan(PLOT.t + PLOT.h + 36);
  });

  it("is exactly reproducible call-to-call, coincident-dot jitter included", () => {
    const rows = [at("A", 50, 0.1), at("B", 50, 0.1), at("C", 50, 0.1)];
    const one = layoutXY(rows);
    const two = layoutXY(rows);
    expect(one.dots.map(({ id, x, y, r }) => ({ id, x, y, r }))).toEqual(
      two.dots.map(({ id, x, y, r }) => ({ id, x, y, r })),
    );
    // Coincident dots separate deterministically and stay inside the plot.
    for (let i = 0; i < one.dots.length; i++) {
      for (let j = i + 1; j < one.dots.length; j++) {
        const a = one.dots[i];
        const b = one.dots[j];
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(1);
      }
      expect(one.dots[i].x).toBeGreaterThanOrEqual(PLOT.l);
      expect(one.dots[i].x).toBeLessThanOrEqual(PLOT.l + PLOT.w);
      expect(one.dots[i].y).toBeGreaterThanOrEqual(PLOT.t);
      expect(one.dots[i].y).toBeLessThanOrEqual(PLOT.t + PLOT.h);
    }
  });

  it("never jitters a pinned dot off its clamp edge", () => {
    const { dots } = layoutXY([at("P1", 900, 0.1), at("P2", 900, 0.1)]);
    for (const d of dots) {
      expect(d.clampX).toBe(1);
      expect(d.x).toBeCloseTo(PLOT.l + PLOT.w - d.r - 1, 4); // still pinned
    }
    // Separated along the free (unpinned) axis instead.
    expect(Math.abs(dots[0].y - dots[1].y)).toBeGreaterThan(1);
  });
});

describe("RadarBoard — dossier stays in view at every width (drawer below lg)", () => {
  // The test setup's matchMedia shim evaluates (min-width: Npx) against
  // window.innerWidth (jsdom default 1024 = the radar's lg threshold = desktop).
  function setViewport(width: number) {
    Object.defineProperty(window, "innerWidth", { value: width, configurable: true, writable: true });
    window.dispatchEvent(new Event("resize"));
  }

  afterEach(() => setViewport(1024));

  it("at ≥lg the dossier is the rail pane, not a modal drawer", () => {
    setViewport(1024);
    renderBoard([makeBlip("Roguelike Deckbuilder", REFERENCE)], true);
    fireEvent.click(screen.getByTestId("radar-blip-tag:Roguelike Deckbuilder"));
    expect(screen.getByTestId("verdict-dossier")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("below lg a dot click opens the slide-over drawer with the same dossier content", () => {
    setViewport(390);
    renderBoard([makeBlip("Roguelike Deckbuilder", REFERENCE)], true);
    fireEvent.click(screen.getByTestId("radar-blip-tag:Roguelike Deckbuilder"));
    const drawer = screen.getByRole("dialog", { name: /verdict dossier: roguelike deckbuilder/i });
    expect(drawer.getAttribute("aria-modal")).toBe("true");
    // Same DossierBody as the rail pane — verdict sentence, a trace row, the deep dive.
    expect(drawer.textContent).toContain("demand surging, but supply flooding");
    expect(drawer.textContent).toContain("Solo evidence · context");
    expect(screen.getByRole("link", { name: /open deep dive/i })).toBeTruthy();
    // The rail list stays where it was (behind the backdrop) — the drawer replaces
    // nothing, so closing lands the user exactly where they were.
    expect(screen.getByTestId("radar-rail-list")).toBeTruthy();
    // Focus moved into the drawer (trap entry point).
    expect(drawer.contains(document.activeElement)).toBe(true);
  });

  it("the drawer closes on ✕, on the back affordance, on the backdrop and on Escape", () => {
    setViewport(390);
    renderBoard([makeBlip("Roguelike Deckbuilder", REFERENCE)], true);
    const open = () => fireEvent.click(screen.getByTestId("radar-blip-tag:Roguelike Deckbuilder"));

    open();
    fireEvent.click(screen.getByRole("button", { name: /close dossier/i }));
    expect(screen.queryByRole("dialog")).toBeNull();

    open();
    fireEvent.click(screen.getByRole("button", { name: /back to all verdicts/i }));
    expect(screen.queryByRole("dialog")).toBeNull();

    open();
    fireEvent.click(screen.getByTestId("drawer-backdrop"));
    expect(screen.queryByRole("dialog")).toBeNull();

    open();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("the drawer locks the page scroll while open and releases it on close", () => {
    setViewport(390);
    renderBoard([makeBlip("Roguelike Deckbuilder", REFERENCE)], true);
    fireEvent.click(screen.getByTestId("radar-blip-tag:Roguelike Deckbuilder"));
    expect(document.body.style.overflow).toBe("hidden");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.body.style.overflow).not.toBe("hidden");
  });

  it("Tab cycles inside the drawer (focus trap), never out of it", () => {
    setViewport(390);
    renderBoard([makeBlip("Roguelike Deckbuilder", REFERENCE)], true);
    fireEvent.click(screen.getByTestId("radar-blip-tag:Roguelike Deckbuilder"));
    const drawer = screen.getByRole("dialog");
    const focusables = Array.from(
      drawer.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'),
    );
    const last = focusables[focusables.length - 1];
    last.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(drawer.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(focusables[0]); // wrapped to the first
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last); // and back
  });
});

describe("RadarBoard — region hover (quadrants + the strip)", () => {
  // One resident per region, spread far from every bar so membership is unambiguous.
  // Verdicts vary on purpose (enter / watch / declining / emerging): region membership
  // is the AXES' side of the bars, not the ring — the two must never be conflated.
  const regionBlips = () => [
    makeBlip("Open Grower", { demand_trend_24m_pct: 120, saturation_yoy: 0.05 }), // growing-open
    makeBlip("Flooded Grower", { demand_trend_24m_pct: 120, saturation_yoy: 0.5 }), // growing-flooding
    makeBlip("Flooded Shrinker", { demand_trend_24m_pct: -50, saturation_yoy: 0.5 }), // shrinking-flooding
    makeBlip("Calm Shrinker", { demand_trend_24m_pct: -50, saturation_yoy: 0.05 }), // shrinking-open
    makeBlip("Newborn", { demand_emerging: true, reviews_24m: 9_000, reviews_24m_new_share: 0.9 }), // strip
  ];
  const PLOT_KEYS = ["Open Grower", "Flooded Grower", "Flooded Shrinker", "Calm Shrinker"];
  const dot = (key: string) => screen.getByTestId(`radar-blip-tag:${key}`);
  const opacityOf = (key: string) => dot(key).getAttribute("opacity");
  const ringOf = (key: string) => screen.queryByTestId(`radar-region-ring-tag:${key}`);

  it("layoutXY precomputes each dot's region from the verdict's own bars (strip included)", () => {
    const byKey = new Map(layoutXY(regionBlips()).dots.map((d) => [d.key, d.region]));
    expect(byKey.get("Open Grower")).toBe("growing-open");
    expect(byKey.get("Flooded Grower")).toBe("growing-flooding");
    expect(byKey.get("Flooded Shrinker")).toBe("shrinking-flooding");
    expect(byKey.get("Calm Shrinker")).toBe("shrinking-open");
    expect(byKey.get("Newborn")).toBe("strip");
  });

  it("membership uses the verdict's exact comparisons: ≥ the enter bar grows, only STRICTLY above the flood bar floods", () => {
    const edge = layoutXY([
      makeBlip("On The Enter Bar", { demand_trend_24m_pct: 40, saturation_yoy: 0.15 }),
      makeBlip("Hair Under Both", { demand_trend_24m_pct: 39.9, saturation_yoy: 0.151 }),
    ]).dots;
    const byKey = new Map(edge.map((d) => [d.key, d.region]));
    // demand ≥ +40 passes the enter check; saturation exactly +0.15 is NOT flooding.
    expect(byKey.get("On The Enter Bar")).toBe("growing-open");
    expect(byKey.get("Hair Under Both")).toBe("shrinking-flooding");
  });

  it("hovering a quadrant emphasizes exactly its member dots, dims the rest, and lifts the wash", () => {
    renderBoard(regionBlips(), true);
    const region = screen.getByTestId("radar-region-growing-open");
    expect(region.getAttribute("fill")).toBe("transparent"); // resting: pure hit rect

    fireEvent.mouseEnter(region);
    // Member pops (full opacity + the slight region ring)…
    expect(opacityOf("Open Grower")).toBe("1");
    expect(ringOf("Open Grower")).toBeTruthy();
    // …every dot outside mutes, strip resident included, and none of them ring.
    for (const key of ["Flooded Grower", "Flooded Shrinker", "Calm Shrinker", "Newborn"]) {
      expect(opacityOf(key)).toBe("0.35");
      expect(ringOf(key)).toBeNull();
    }
    // The region itself lifts: wash fill on, and only on the hovered rect.
    expect(region.getAttribute("fill")).toMatch(/^color-mix/);
    expect(screen.getByTestId("radar-region-shrinking-flooding").getAttribute("fill")).toBe("transparent");
  });

  it("the EMERGING strip is a fifth region with the same contract", () => {
    renderBoard(regionBlips(), true);
    fireEvent.mouseEnter(screen.getByTestId("radar-region-strip"));
    expect(opacityOf("Newborn")).toBe("1");
    expect(ringOf("Newborn")).toBeTruthy();
    for (const key of PLOT_KEYS) {
      expect(opacityOf(key)).toBe("0.35");
      expect(ringOf(key)).toBeNull();
    }
    expect(screen.getByTestId("radar-region-strip").getAttribute("fill")).toMatch(/^color-mix/);
  });

  it("a board with no strip residents renders no strip hit rect (the quadrants keep theirs)", () => {
    renderBoard(
      regionBlips().filter((b) => !b.demandEmerging),
      true,
    );
    expect(screen.queryByTestId("radar-region-strip")).toBeNull();
    expect(screen.getByTestId("radar-region-growing-open")).toBeTruthy();
  });

  it("mouse leave restores every dot, ring and wash — hover-only, nothing sticks", () => {
    renderBoard(regionBlips(), true);
    const region = screen.getByTestId("radar-region-growing-open");
    fireEvent.mouseEnter(region);
    fireEvent.mouseLeave(region);
    for (const key of [...PLOT_KEYS, "Newborn"]) {
      expect(opacityOf(key)).toBe("1");
      expect(ringOf(key)).toBeNull();
    }
    expect(region.getAttribute("fill")).toBe("transparent");
    // And no dossier opened — the region rects are hover-only, never click targets.
    fireEvent.click(region);
    expect(screen.queryByTestId("verdict-dossier")).toBeNull();
  });

  it("dot hover takes precedence: the tooltip's single-dot emphasis wins, and the wash follows the dot's own region", () => {
    renderBoard(regionBlips(), true);
    fireEvent.mouseEnter(screen.getByTestId("radar-region-growing-open"));
    fireEvent.mouseEnter(dot("Flooded Shrinker"));
    // Existing dot-hover behavior, untouched: only the hovered dot stays full, EVEN the
    // hovered region's member dims, and no region ring draws while a dot is hovered.
    expect(opacityOf("Flooded Shrinker")).toBe("1");
    expect(opacityOf("Open Grower")).toBe("0.35");
    expect(ringOf("Open Grower")).toBeNull();
    expect(ringOf("Flooded Shrinker")).toBeNull();
    // The tooltip is the existing one.
    expect(screen.getByText(/Flooded Shrinker — Micro-genres/)).toBeTruthy();
    // The wash follows the DOT's region (the pointer is physically there now).
    expect(screen.getByTestId("radar-region-shrinking-flooding").getAttribute("fill")).toMatch(/^color-mix/);
    expect(screen.getByTestId("radar-region-growing-open").getAttribute("fill")).toBe("transparent");
    // Leaving the dot hands emphasis back to the still-hovered region.
    fireEvent.mouseLeave(dot("Flooded Shrinker"));
    expect(opacityOf("Open Grower")).toBe("1");
    expect(ringOf("Open Grower")).toBeTruthy();
  });

  it("rail rows of the hovered region take the left-edge tick — never reordered or filtered", () => {
    renderBoard(regionBlips(), true);
    const rowKeys = () =>
      Array.from(screen.getByTestId("radar-rail-list").querySelectorAll("button[data-testid^='radar-row-']")).map(
        (el) => el.getAttribute("data-testid"),
      );
    const before = rowKeys();
    fireEvent.mouseEnter(screen.getByTestId("radar-region-growing-open"));
    expect(screen.getByTestId("radar-row-tag:Open Grower").getAttribute("data-region-tick")).toBe("growing-open");
    for (const key of ["Flooded Grower", "Flooded Shrinker", "Calm Shrinker", "Newborn"]) {
      expect(screen.getByTestId(`radar-row-tag:${key}`).getAttribute("data-region-tick")).toBeNull();
    }
    expect(rowKeys()).toEqual(before); // same rows, same order — a reading aid only
    fireEvent.mouseLeave(screen.getByTestId("radar-region-growing-open"));
    expect(screen.getByTestId("radar-row-tag:Open Grower").getAttribute("data-region-tick")).toBeNull();
  });
});
