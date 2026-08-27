import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import {
  BLIP_R_DENSE_MIN,
  RadarBoard,
  layoutBlips,
  type PlacedBlip,
  type RadarBoardBlip,
} from "./RadarBoard";
import {
  SOLO_FRIENDLY_MIN,
  blipRadius,
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
 *    hairline rings/decor and the legend's sample circles must never open a dossier.
 *
 * 4. NO SILENT CAPS (A1). The rail renders EVERY entry of every ring group, and the group
 *    headers carry the full counts.
 *
 * 5. DETERMINISTIC, DENSITY-AWARE LAYOUT (A2). layoutBlips scales a crowded cell's radii
 *    down together (bounded below), never moves a dot out of its cell, and is exactly
 *    reproducible call-to-call.
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
  it("clicking the decorative ring hairlines never opens a dossier", () => {
    const { container } = renderBoard([makeBlip("Roguelike Deckbuilder", REFERENCE)], true);
    // The FIRST `svg circle` in the document is a verdict-ring hairline, not a blip —
    // exactly what a naive scripted `click('svg circle')` hits.
    const firstCircle = container.querySelector("svg circle")!;
    expect(firstCircle.getAttribute("data-testid")).toBeNull();
    fireEvent.click(firstCircle);
    expect(screen.queryByTestId("verdict-dossier")).toBeNull();
    // The whole decor group is pointer-inert, so it cannot even intercept a dot click.
    expect(firstCircle.closest("g")?.getAttribute("pointer-events")).toBe("none");
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

describe("layoutBlips — deterministic, density-aware placement (A2)", () => {
  const dense = Array.from({ length: 60 }, (_, i) =>
    makeBlip(`Dense ${String(i).padStart(2, "0")}`, { demand_trend_24m_pct: 10 }, { p90_rev: 900_000 }),
  );

  function maxBaseRadius(blips: RadarBoardBlip[]): number {
    const maxP90 = blips.reduce<number>((m, b) => Math.max(m, b.p90_rev ?? 0), 0);
    return Math.max(...blips.map((b) => blipRadius(b.p90_rev, maxP90)));
  }

  it("is exactly reproducible call-to-call (no hidden randomness)", () => {
    const a = layoutBlips(dense);
    const b = layoutBlips(dense);
    expect(a.map(({ id, x, y, r }) => ({ id, x, y, r }))).toEqual(b.map(({ id, x, y, r }) => ({ id, x, y, r })));
  });

  it("scales a crowded cell's radii down together, bounded below", () => {
    const placed = layoutBlips(dense);
    const base = maxBaseRadius(dense); // all dots share p90 -> identical base radius
    for (const p of placed) {
      expect(p.r).toBeLessThan(base); // 60 max-size dots cannot fit unshrunk
      expect(p.r).toBeGreaterThanOrEqual(BLIP_R_DENSE_MIN);
    }
    // A sparse board keeps its full-size dots — scaling only bites under pressure.
    const sparse = layoutBlips(dense.slice(0, 3));
    for (const p of sparse) {
      expect(p.r).toBeCloseTo(maxBaseRadius(dense.slice(0, 3)), 6);
    }
  });

  it("never lets the relax push a dot outside its (sector, ring) cell", () => {
    const placed = layoutBlips(dense);
    const C = 320; // board center (SIZE / 2)
    const R = 284;
    // All fixtures are watch-ring (index 1 -> annulus 0.3..0.52 of R) in the micro
    // sector (index 1 -> angle span [π/6, 5π/6) measured from straight-up start).
    for (const p of placed as PlacedBlip[]) {
      const radius = Math.hypot(p.x - C, p.y - C);
      expect(radius).toBeGreaterThanOrEqual(0.3 * R - 1e-6);
      expect(radius).toBeLessThanOrEqual(0.52 * R + 1e-6);
      let angle = Math.atan2(p.y - C, p.x - C) - (-Math.PI / 2 + (2 * Math.PI) / 3);
      angle = ((angle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      expect(angle).toBeLessThanOrEqual((2 * Math.PI) / 3 + 1e-6);
    }
  });

  it("keeps severe pile-ups out: no two dots sit closer than half their combined radii", () => {
    const placed = layoutBlips(dense);
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const a = placed[i];
        const b = placed[j];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        expect(dist).toBeGreaterThan((a.r + b.r) / 2);
      }
    }
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
