import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import {
  DEFAULT_PLATE_W,
  RadarBoard,
  layoutBoard,
  type RadarBoardBlip,
  type RadarRegion,
  type RadarSector,
} from "./RadarBoard";
import { CLASS_ORDER, ringGeom, sectorSpans } from "./radarRings";
import {
  RING_ORDER,
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
 *    the solo row's inline member evidence, and the DEEP-DIVE BUTTON — a real filled
 *    primary action since 2026-09-10 ("Button to go deeper into the niche is super small
 *    and almost not visible"), not the 13px text link it used to be.
 *
 * 3. CLICK-TARGET HYGIENE (A4). Only blip dots and the ring hit-areas are interactive
 *    inside the SVG — the decor, the band captions and the legend's sample circles must
 *    never open a dossier.
 *
 * 4. NO SILENT CAPS (A1). The rail renders EVERY entry of every ring group, and the group
 *    headers carry the full counts.
 *
 * 5. THE CONCENTRIC-RING DIAL (2026-09-10 directive: "I think circle is a better
 *    representation for radar. Like we do there: https://solidgate-tech.github.io/ Best -
 *    niches are in the middle"). The band IS the verdict, inner to outer in RING_ORDER;
 *    the sector is the niche class (three fixed 120° wedges, all three always drawn — the
 *    2026-09-10 second pass); distance inside a band is the opportunity rank; each dot
 *    carries the rail number that keys it to the list. The old plate's clamp chevrons and
 *    its no-XY strip are gone WITH their reasons — a ring board has no axis to fall off,
 *    and every row has a verdict, so every row has an honest place. layoutBoard is
 *    deterministic call-to-call, collision pass included. (The placement invariants
 *    themselves live in radarRings.test.ts, on the pure function.)
 *
 * 6. NICHE SEARCH OVER THE FULL POOL (2026-08-27 directive). The rail search filters the
 *    WHOLE population (`pool` prop), not just the plotted Top-N: a beyond-plot match
 *    appears (dash rank), opens a full dossier with the honest "beyond the Top N plot"
 *    note, a plotted match never carries that note, zero matches get an honest empty row
 *    naming the searched population, and Esc clears back to the plotted list.
 *
 * 7. CLICK-TO-ZOOM (2026-08-28 directive, re-cut to the rings). Clicking a ring's EMPTY
 *    area zooms the dial into that band (it expands to fill the whole dial, non-members do
 *    not render) and filters the rail to its members (chip + honest recomputed counts).
 *    Search composes with the filter. Dot clicks keep dossier precedence. Three exits: chip
 *    ✕, Esc (search text clears first), and a board-background click.
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

/** Selection AND the click-to-zoom ring are controlled by the page (the zoom joined the
 * controlled set on 2026-09-01, when /radar started carrying it in ?zoom=) — the harness
 * stands in for the page for both. `pool` defaults to the plotted blips (the common case in
 * these tests); the search suite passes a strictly larger pool to pin the beyond-plot
 * behavior. */
function Harness({
  blips,
  soloOnly,
  pool,
  plotCap,
  emphasis = null,
}: {
  blips: RadarBoardBlip[];
  soloOnly: boolean;
  pool?: RadarBoardBlip[];
  plotCap?: number;
  emphasis?: RadarSector | null;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [zoom, setZoom] = useState<RadarRegion | null>(null);
  return (
    <MemoryRouter>
      <RadarBoard
        blips={blips}
        pool={pool ?? blips}
        plotCap={plotCap ?? blips.length}
        soloOnly={soloOnly}
        emphasis={emphasis}
        selectedId={selectedId}
        onSelect={setSelectedId}
        zoom={zoom}
        onZoom={setZoom}
      />
    </MemoryRouter>
  );
}

function renderBoard(
  blips: RadarBoardBlip[],
  soloOnly: boolean,
  extra: { pool?: RadarBoardBlip[]; plotCap?: number; emphasis?: RadarSector | null } = {},
) {
  return render(
    <Harness
      blips={blips}
      soloOnly={soloOnly}
      pool={extra.pool}
      plotCap={extra.plotCap}
      emphasis={extra.emphasis ?? null}
    />,
  );
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
  it("clicking the ring decor or a band caption never opens a dossier", () => {
    renderBoard([makeBlip("Roguelike Deckbuilder", REFERENCE)], true);
    // The decor group (band washes, band circles, spokes, centre mark, captions) is
    // pointer-inert as a GROUP, so a misaimed or scripted click on a caption can never
    // read as a dead dot — it falls through to the band hit-area under it.
    expect(screen.getByTestId("ring-decor").getAttribute("pointer-events")).toBe("none");
    fireEvent.click(screen.getByTestId("ring-caption-enter"));
    fireEvent.click(screen.getByTestId("ring-caption-declining"));
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

  it("the blip NUMBER is inert — the dot under it keeps its click", () => {
    renderBoard([makeBlip("Roguelike Deckbuilder", REFERENCE)], true);
    const num = screen.getByTestId("radar-blip-num-tag:Roguelike Deckbuilder");
    expect(num.getAttribute("pointer-events")).toBe("none");
    fireEvent.click(screen.getByTestId("radar-blip-tag:Roguelike Deckbuilder"));
    expect(screen.getByTestId("verdict-dossier")).toBeTruthy();
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
    expect(dossier.textContent).toContain("Beyond the Top 2 of Micro-genres");
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

describe("RadarBoard — the concentric-ring dial", () => {
  /** One blip per ring, so every band has a resident. */
  const ringBlips = () => [
    makeBlip("Grower", { demand_trend_24m_pct: 120, saturation_yoy: 0.05, opportunity_v2: 90 }), // enter
    makeBlip("Holder", { demand_trend_24m_pct: 10, saturation_yoy: 0.05, opportunity_v2: 70 }), // watch
    makeBlip("Newborn", { demand_emerging: true, reviews_24m: 9_000, reviews_24m_new_share: 0.9, opportunity_v2: 60 }), // emerging
    makeBlip("Packed", { demand_trend_24m_pct: -5, saturation_yoy: 0.9, opportunity_v2: 40 }), // crowded
    makeBlip("Fading", { demand_trend_24m_pct: -60, saturation_yoy: 0.05, opportunity_v2: 20 }), // declining
  ];

  it("draws the five verdict bands inner-to-outer in RING_ORDER, each captioned inside itself", () => {
    renderBoard(ringBlips(), true);
    const geom = layoutBoard(ringBlips()).geom;
    expect(geom.bands.map((b) => b.ring)).toEqual(RING_ORDER);
    for (const b of geom.bands) {
      expect(screen.getByTestId(`ring-band-${b.ring}`)).toBeTruthy();
      const cap = screen.getByTestId(`ring-caption-${b.ring}`);
      // The caption sits ON the 12 o'clock axis, INSIDE its own band and in its OUTER half —
      // the reference's ADOPT / TRIAL / ASSESS / HOLD placement, measured (`-ringRadius + 62`).
      expect(Number(cap.getAttribute("x"))).toBeCloseTo(geom.cx, 3);
      const up = geom.cy - Number(cap.getAttribute("y"));
      expect(up).toBeGreaterThan(b.mid - b.captionSize);
      expect(up).toBeLessThan(b.r1);
    }
    // One word per band — the reference's own wording length. The full ring phrasing lives
    // in the rail group header, the legend and the dossier.
    expect(screen.getByTestId("ring-caption-enter").textContent).toBe("ENTER");
    expect(screen.getByTestId("ring-caption-declining").textContent).toBe("DECLINING");
    // Captions run outward: each one is drawn further from the centre than the last.
    const up = (ring: string) => geom.cy - Number(screen.getByTestId(`ring-caption-${ring}`).getAttribute("y"));
    for (let i = 1; i < RING_ORDER.length; i++) {
      expect(up(RING_ORDER[i])).toBeGreaterThan(up(RING_ORDER[i - 1]));
    }
    // …and every one of them is in the TOP half of the dial, stacked on one axis.
    for (const b of geom.bands) {
      expect(Number(screen.getByTestId(`ring-caption-${b.ring}`).getAttribute("y"))).toBeLessThan(geom.cy);
    }
  });

  it("colours each caption to its OWN ring, like the reference's green ADOPT", () => {
    renderBoard(ringBlips(), true);
    // The blip fill and the band caption must be the same token: that is the whole trick
    // that turns five words into structure instead of grey wallpaper.
    for (const ring of RING_ORDER) {
      const cap = screen.getByTestId(`ring-caption-${ring}`);
      const dot = screen.getByTestId(`radar-blip-tag:${{ enter: "Grower", watch: "Holder", emerging: "Newborn", crowded: "Packed", declining: "Fading" }[ring]}`);
      expect(cap.style.fill).toBe(dot.getAttribute("fill"));
      // Legible, not wallpaper: the first cut drew these at 0.4.
      expect(Number(cap.getAttribute("opacity"))).toBeGreaterThanOrEqual(0.6);
    }
  });

  it("puts the BEST verdict in the middle — a blip's distance from the centre IS its ring", () => {
    renderBoard(ringBlips(), true);
    expect(screen.getByText("BEST")).toBeTruthy(); // the centre mark says so once
    const layout = layoutBoard(ringBlips());
    const { cx, cy } = layout.geom;
    for (const d of layout.dots) {
      const band = layout.geom.band(d.verdict.ring)!;
      const dot = screen.getByTestId(`radar-blip-tag:${d.key}`);
      const dist = Math.hypot(Number(dot.getAttribute("cx")) - cx, Number(dot.getAttribute("cy")) - cy);
      expect(dist).toBeGreaterThanOrEqual(band.r0);
      expect(dist).toBeLessThanOrEqual(band.r1);
    }
    // And "enter" really is nearer the middle than "declining".
    const at = (key: string) => layout.dots.find((d) => d.key === key)!.radius;
    expect(at("Grower")).toBeLessThan(at("Holder"));
    expect(at("Holder")).toBeLessThan(at("Fading"));
  });

  it("numbers every dot and keys the number to the rail row, like the reference does", () => {
    renderBoard(ringBlips(), true);
    for (const d of layoutBoard(ringBlips()).dots) {
      expect(screen.getByTestId(`radar-blip-num-tag:${d.key}`).textContent).toBe(String(d.n));
      // The rail row leads with the same rank — one list, two presentations.
      const rank = screen.getByTestId(`radar-row-tag:${d.key}`).querySelector("span")!;
      expect(rank.textContent).toBe(String(d.n));
    }
  });

  it("always draws THREE class wedges with dividers, even when a class has no rows", () => {
    renderBoard(ringBlips(), true); // every fixture row is class "micro"
    expect(screen.getByTestId("radar-sector-label-micro").textContent).toContain("MICRO-GENRES");
    expect(screen.getByTestId("radar-sector-label-micro").textContent).toContain("5");
    // An empty class is an empty WEDGE with an honest count, never a wedge that vanishes —
    // that is what keeps a niche in the same place from one visit to the next.
    expect(screen.getByTestId("radar-sector-label-genre").textContent).toContain("GENRES · 0");
    expect(screen.getByTestId("radar-sector-label-theme").textContent).toContain("THEMES · 0");
    for (const sector of CLASS_ORDER) expect(screen.getByTestId(`radar-spoke-${sector}`)).toBeTruthy();
  });

  it("puts each blip in the wedge its CLASS names — three sectors on ONE board", () => {
    const mixed = [
      makeBlip("Micro One", { demand_trend_24m_pct: 10 }, { tier: "micro", sector: "micro" }),
      makeBlip("Theme One", { demand_trend_24m_pct: 10 }, { tier: "theme", sector: "theme" }),
      makeBlip("Genre One", { demand_trend_24m_pct: 10 }, { tier: "genre", dimension: "genre", sector: "genre" }),
    ];
    renderBoard(mixed, true);
    for (const sector of CLASS_ORDER) {
      expect(screen.getByTestId(`radar-sector-label-${sector}`).textContent).toContain("· 1");
      expect(screen.getByTestId(`radar-spoke-${sector}`)).toBeTruthy();
    }
    // Each blip lands in the wedge its class names, and all three are on the dial at once —
    // the density fix: the reference's ~14-per-quadrant, not 80 in one full circle.
    const layout = layoutBoard(mixed);
    const spans = new Map(layout.sectors.map((s) => [s.sector, s]));
    for (const d of layout.dots) {
      expect(d.wedge).toBe(d.sector);
      const span = spans.get(d.wedge)!;
      let off = (d.angle - span.a0) % (Math.PI * 2);
      if (off < 0) off += Math.PI * 2;
      expect(off).toBeLessThanOrEqual(span.a1 - span.a0 + 1e-6);
    }
    expect(layout.dots.find((d) => d.key === "Genre One")!.wedge).toBe("genre");
  });

  it("EMPHASIS dims the other two wedges instead of removing them", () => {
    const mixed = [
      makeBlip("Micro One", { demand_trend_24m_pct: 10 }, { tier: "micro", sector: "micro" }),
      makeBlip("Theme One", { demand_trend_24m_pct: 10 }, { tier: "theme", sector: "theme" }),
      makeBlip("Genre One", { demand_trend_24m_pct: 10 }, { tier: "genre", dimension: "genre", sector: "genre" }),
    ];
    renderBoard(mixed, true, { emphasis: "theme" });
    // Every dot is still ON the board — the class control is a lens, not a filter.
    const dot = (id: string) => screen.getByTestId(`radar-blip-${id}`);
    expect(Number(dot("tag:Theme One").getAttribute("opacity"))).toBe(1);
    expect(Number(dot("tag:Micro One").getAttribute("opacity"))).toBeLessThan(1);
    expect(Number(dot("genre:Genre One").getAttribute("opacity"))).toBeLessThan(1);
    expect(Number(dot("tag:Micro One").getAttribute("opacity"))).toBeGreaterThan(0.2);
    // The rail says the same thing at the same strength, and removes nothing.
    expect(screen.getByTestId("radar-row-tag:Micro One").getAttribute("data-off-class")).toBe("micro");
    expect(screen.getByTestId("radar-row-tag:Theme One").getAttribute("data-off-class")).toBeNull();
    expect(screen.getByTestId("radar-row-genre:Genre One")).toBeTruthy();
    // …and so does the rim: the emphasised class is the one in primary ink.
    expect(screen.getByTestId("radar-sector-label-theme").style.fill).toBe("var(--text-primary)");
    expect(screen.getByTestId("radar-sector-label-micro").style.fill).toBe("var(--text-muted)");
  });

  it("with no emphasis every wedge reads at full strength", () => {
    const mixed = [
      makeBlip("Micro One", { demand_trend_24m_pct: 10 }, { tier: "micro", sector: "micro" }),
      makeBlip("Theme One", { demand_trend_24m_pct: 10 }, { tier: "theme", sector: "theme" }),
    ];
    renderBoard(mixed, true);
    expect(Number(screen.getByTestId("radar-blip-tag:Micro One").getAttribute("opacity"))).toBe(1);
    expect(Number(screen.getByTestId("radar-blip-tag:Theme One").getAttribute("opacity"))).toBe(1);
    expect(screen.getByTestId("radar-row-tag:Micro One").getAttribute("data-off-class")).toBeNull();
  });

  it("has no clamp chevrons and no no-position strip — the form removed the need for both", () => {
    // The XY plate pinned a beyond-domain value at the plot edge with a chevron, and parked
    // emerging / no-trend rows in a dashed strip. Neither can exist here: the radial channel
    // is a within-band rank and the angular one is free, so nothing falls off the scale; and
    // every row has a verdict, so the emerging rows sit in the emerging band.
    renderBoard(
      [
        makeBlip("Runaway", { demand_trend_24m_pct: 900, saturation_yoy: 43, opportunity_v2: 50 }),
        makeBlip("No Trend", { saturation_yoy: 0.1, opportunity_v2: 30 }),
        makeBlip("Newborn", { demand_emerging: true, reviews_24m: 9_000, opportunity_v2: 60 }),
      ],
      true,
    );
    expect(screen.queryByTestId("xy-strip")).toBeNull();
    expect(screen.queryByTestId("radar-clamp-tag:Runaway")).toBeNull();
    for (const key of ["Runaway", "No Trend", "Newborn"]) {
      expect(screen.getByTestId(`radar-blip-tag:${key}`)).toBeTruthy();
    }
    // The emerging row is in the EMERGING band, not below the board.
    const layout = layoutBoard([makeBlip("Newborn", { demand_emerging: true, reviews_24m: 9_000, opportunity_v2: 60 })]);
    const band = layout.geom.band("emerging")!;
    expect(layout.dots[0].radius).toBeGreaterThanOrEqual(band.r0);
    expect(layout.dots[0].radius).toBeLessThanOrEqual(band.r1);
  });

  it("the legend states the ring reading honestly and keeps the verdict hue key", () => {
    renderBoard([makeBlip("Roguelike Deckbuilder", REFERENCE)], true);
    expect(screen.getByText(/ring = the verdict, best in the middle/)).toBeTruthy();
    expect(screen.getByText(/nearer the centre = higher opportunity v2/)).toBeTruthy();
    expect(screen.getByText(/nothing clamps here: a ring board has no axis to fall off/)).toBeTruthy();
    // The two new claims of the three-sector rebuild, said where the reader is looking.
    expect(screen.getByText(/the three sectors are the niche classes/)).toBeTruthy();
    expect(screen.getByText(/emphasises a sector, it never empties the board/)).toBeTruthy();
    // Every hue is still doubled by its word, inner ring named as such.
    const key = screen.getByTestId("verdict-color-key");
    expect(key.textContent).toContain("Enter now (inner ring)");
    expect(key.textContent).toContain("Declining (outer)");
  });
});

describe("layoutBoard — deterministic, honest placement", () => {
  const watchers = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      makeBlip(`Watcher ${String(i).padStart(2, "0")}`, { demand_trend_24m_pct: 10, opportunity_v2: 70 - i }),
    );

  it("numbers the rail exactly as before: ring order, then opportunity desc, then key", () => {
    const { dots } = layoutBoard([
      makeBlip("Second Enter", { demand_trend_24m_pct: 120, saturation_yoy: 0, opportunity_v2: 60 }),
      makeBlip("A Watcher", { demand_trend_24m_pct: 10, opportunity_v2: 99 }),
      makeBlip("First Enter", { demand_trend_24m_pct: 120, saturation_yoy: 0, opportunity_v2: 85 }),
    ]);
    expect(dots.map((d) => [d.n, d.key])).toEqual([
      [1, "First Enter"],
      [2, "Second Enter"],
      [3, "A Watcher"],
    ]);
  });

  it("never lets a blip leave the band its verdict names, however crowded the band gets", () => {
    const layout = layoutBoard(watchers(40));
    const band = layout.geom.band("watch")!;
    for (const d of layout.dots) {
      expect(d.region).toBe("watch");
      expect(d.radius - d.r).toBeGreaterThanOrEqual(band.r0 - 1e-6);
      expect(d.radius + d.r).toBeLessThanOrEqual(band.r1 + 1e-6);
    }
  });

  it("orders a band by opportunity_v2 — the higher score ranks nearer the middle", () => {
    const layout = layoutBoard(watchers(12));
    const sorted = [...layout.dots].sort((a, b) => (b.opportunity_v2 ?? 0) - (a.opportunity_v2 ?? 0));
    // The rank IS the radial order; the relaxation may shuffle neighbours a little inside
    // the band, so the claim is a monotone TREND across the cell, not a strict per-pair
    // ordering (the rank itself is exact — cellRank).
    expect(sorted.map((d) => d.cellRank)).toEqual(sorted.map((_, i) => i));
    expect(sorted[0].radius).toBeLessThan(sorted[sorted.length - 1].radius);
    const half = Math.floor(sorted.length / 2);
    const mean = (xs: typeof sorted) => xs.reduce((a, d) => a + d.radius, 0) / xs.length;
    expect(mean(sorted.slice(0, half))).toBeLessThan(mean(sorted.slice(half)));
  });

  it("is exactly reproducible call-to-call, force relaxation included", () => {
    const rows = watchers(24);
    const one = layoutBoard(rows);
    // A different call in between must not leak into the next one (the layout memo is a
    // one-slot cache keyed on the row set, so this also pins that the key is honest).
    layoutBoard(watchers(9));
    const two = layoutBoard(rows);
    expect(one.dots.map(({ id, x, y, r, n }) => ({ id, x, y, r, n }))).toEqual(
      two.dots.map(({ id, x, y, r, n }) => ({ id, x, y, r, n })),
    );
    // Identical-score rows in one cell still separate — nothing coincides.
    const same = layoutBoard(
      Array.from({ length: 10 }, (_, i) => makeBlip(`Twin ${i}`, { demand_trend_24m_pct: 10, opportunity_v2: 50 })),
    ).dots;
    for (let i = 0; i < same.length; i++) {
      for (let j = i + 1; j < same.length; j++) {
        expect(Math.hypot(same[i].x - same[j].x, same[i].y - same[j].y)).toBeGreaterThan(1);
      }
    }
  });

  it("leaves ZERO overlapping dot pairs on a three-sector board at the live Top-80 shape", () => {
    // ~27 rows per class, the live production split (solo-friendly cut). The whole point of
    // the d3-force placement: every segment fills evenly and nothing touches.
    const rows: RadarBoardBlip[] = [];
    const mk = (sector: RadarSector, ring: "enter" | "watch" | "crowded", i: number) =>
      makeBlip(
        `${sector}-${ring}-${i}`,
        ring === "enter"
          ? { demand_trend_24m_pct: 120, saturation_yoy: 0.02, opportunity_v2: 90 - i }
          : ring === "crowded"
            ? { demand_trend_24m_pct: -5, saturation_yoy: 0.9, opportunity_v2: 60 - i }
            : { demand_trend_24m_pct: 10, saturation_yoy: 0.05, opportunity_v2: 75 - i },
        { sector, dimension: sector === "genre" ? "genre" : "tag", tier: sector === "genre" ? "genre" : sector },
      );
    for (let i = 0; i < 5; i++) rows.push(mk("genre", "watch", i));
    for (let i = 0; i < 4; i++) rows.push(mk("genre", "crowded", i));
    for (const sector of ["micro", "theme"] as const) {
      for (let i = 0; i < 6; i++) rows.push(mk(sector, "enter", i));
      for (let i = 0; i < 13; i++) rows.push(mk(sector, "watch", i));
      for (let i = 0; i < 8; i++) rows.push(mk(sector, "crowded", i));
    }
    const dots = layoutBoard(rows, { plateW: DEFAULT_PLATE_W }).dots;
    expect(dots).toHaveLength(63);
    let overlapping = 0;
    for (let i = 0; i < dots.length; i++) {
      for (let j = i + 1; j < dots.length; j++) {
        if (Math.hypot(dots[i].x - dots[j].x, dots[i].y - dots[j].y) < dots[i].r + dots[j].r - 1e-6) overlapping += 1;
      }
    }
    expect(overlapping).toBe(0);
    // Every class really got its own wedge's worth of the board.
    for (const sector of CLASS_ORDER) expect(dots.some((d) => d.wedge === sector)).toBe(true);
  });

  it("sizes the dial from the measured width and keeps every dot inside the viewBox", () => {
    for (const plateW of [340, 620, DEFAULT_PLATE_W]) {
      const layout = layoutBoard(watchers(20), { plateW });
      expect(layout.geom.plateW).toBe(plateW);
      for (const d of layout.dots) {
        expect(d.x - d.r).toBeGreaterThanOrEqual(0);
        expect(d.x + d.r).toBeLessThanOrEqual(plateW);
        expect(d.y - d.r).toBeGreaterThanOrEqual(0);
        expect(d.y + d.r).toBeLessThanOrEqual(layout.vbH);
      }
    }
  });

  it("shrinks every blip by ONE factor when a cell is too crowded to separate", () => {
    // Three P90 revenues, so the size channel has something to preserve. The same three
    // values appear in BOTH fixtures (and so does the maximum), which is what makes the
    // ratio comparison below meaningful rather than a comparison of two different scales.
    const P90 = [200_000, 700_000, 1_600_000];
    const mk = (sector: RadarSector, i: number): RadarBoardBlip =>
      makeBlip(
        `${sector} ${String(i).padStart(2, "0")}`,
        i % 5 === 0
          ? { demand_trend_24m_pct: 120, saturation_yoy: 0.02, opportunity_v2: 95 - i }
          : i % 5 === 4
            ? { demand_trend_24m_pct: -5, saturation_yoy: 0.9, opportunity_v2: 95 - i }
            : { demand_trend_24m_pct: 10, saturation_yoy: 0.05, opportunity_v2: 95 - i },
        {
          sector,
          dimension: sector === "genre" ? "genre" : "tag",
          tier: sector === "genre" ? "genre" : sector,
          p90_rev: P90[i % 3],
        },
      );
    // A REAL phone board at the biggest cap: Top 120 is 40 rows per class.
    const crowded = CLASS_ORDER.flatMap((sector) => Array.from({ length: 40 }, (_, i) => mk(sector, i)));
    // …and the same rows in a cut sparse enough that no crowd fit fires at all.
    const airy = CLASS_ORDER.flatMap((sector) => [mk(sector, 0), mk(sector, 1), mk(sector, 2)]);

    const tight = layoutBoard(crowded, { plateW: 390 });
    const loose = layoutBoard(airy, { plateW: 390 });
    const rOf = (l: typeof tight, key: string) => l.dots.find((d) => d.key === key)!.r;
    // Same dial, same revenue scale — so the only difference is the crowd fit, and it really
    // fired.
    expect(rOf(tight, "micro 00")).toBeLessThan(rOf(loose, "micro 00"));
    // …and it is ONE factor: every pairwise size ratio (the P90-revenue channel) survives.
    expect(rOf(tight, "micro 00") / rOf(tight, "micro 02")).toBeCloseTo(
      rOf(loose, "micro 00") / rOf(loose, "micro 02"),
      6,
    );
    expect(rOf(tight, "micro 00") / rOf(loose, "micro 00")).toBeCloseTo(
      rOf(tight, "theme 02") / rOf(loose, "theme 02"),
      6,
    );
    // The point of the shrink: nothing on the phone dial ends up touching.
    const pts = tight.dots;
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        expect(Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y)).toBeGreaterThanOrEqual(
          pts[i].r + pts[j].r - 1e-6,
        );
      }
    }
  });

  it("keeps the geometry the renderer draws with in step with the sectors it allocated", () => {
    const layout = layoutBoard(watchers(4));
    expect(layout.sectors).toEqual(sectorSpans());
    expect(layout.geom.R).toBeCloseTo(ringGeom(DEFAULT_PLATE_W, null).R, 6);
    expect(layout.sectorCount.get("micro")).toBe(4);
    // Every class is counted, including the ones with nothing in them.
    expect(layout.sectorCount.get("genre")).toBe(0);
    expect(layout.sectorCount.get("theme")).toBe(0);
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

describe("RadarBoard — ring hover (the bands are the regions)", () => {
  // One resident per band. The region IS the verdict now, so membership and the rail's
  // grouping are the same partition by construction — they cannot drift the way the XY
  // plate's quadrant membership could.
  const regionBlips = () => [
    makeBlip("Grower", { demand_trend_24m_pct: 120, saturation_yoy: 0.05, opportunity_v2: 90 }), // enter
    makeBlip("Holder", { demand_trend_24m_pct: 10, saturation_yoy: 0.05, opportunity_v2: 70 }), // watch
    makeBlip("Newborn", { demand_emerging: true, reviews_24m: 9_000, reviews_24m_new_share: 0.9, opportunity_v2: 60 }), // emerging
    makeBlip("Packed", { demand_trend_24m_pct: -5, saturation_yoy: 0.9, opportunity_v2: 40 }), // crowded
    makeBlip("Fading", { demand_trend_24m_pct: -60, saturation_yoy: 0.05, opportunity_v2: 20 }), // declining
  ];
  const OTHERS = ["Holder", "Newborn", "Packed", "Fading"];
  const dot = (key: string) => screen.getByTestId(`radar-blip-tag:${key}`);
  const opacityOf = (key: string) => dot(key).getAttribute("opacity");
  const ringOf = (key: string) => screen.queryByTestId(`radar-region-ring-tag:${key}`);

  it("layoutBoard gives every dot the band its verdict names — region and ring are one thing", () => {
    const byKey = new Map(layoutBoard(regionBlips()).dots.map((d) => [d.key, d.region]));
    expect(byKey.get("Grower")).toBe("enter");
    expect(byKey.get("Holder")).toBe("watch");
    expect(byKey.get("Newborn")).toBe("emerging");
    expect(byKey.get("Packed")).toBe("crowded");
    expect(byKey.get("Fading")).toBe("declining");
    for (const d of layoutBoard(regionBlips()).dots) expect(d.region).toBe(d.verdict.ring);
  });

  it("hovering a band emphasizes exactly its member dots, dims the rest, and lifts the wash", () => {
    renderBoard(regionBlips(), true);
    const region = screen.getByTestId("radar-region-enter");
    expect(region.getAttribute("fill")).toBe("transparent"); // resting: pure hit area

    fireEvent.mouseEnter(region);
    expect(opacityOf("Grower")).toBe("1");
    expect(ringOf("Grower")).toBeTruthy();
    for (const key of OTHERS) {
      expect(opacityOf(key)).toBe("0.35");
      expect(ringOf(key)).toBeNull();
    }
    // The band itself lifts: wash fill on, and only on the hovered band.
    expect(region.getAttribute("fill")).toMatch(/^color-mix/);
    expect(screen.getByTestId("radar-region-crowded").getAttribute("fill")).toBe("transparent");
    // …and its caption steps out of the wallpaper into full ink.
    expect(Number(screen.getByTestId("ring-caption-enter").getAttribute("opacity"))).toBeGreaterThan(
      Number(screen.getByTestId("ring-caption-crowded").getAttribute("opacity")),
    );
  });

  it("every one of the five bands is a hover region with the same contract", () => {
    renderBoard(regionBlips(), true);
    for (const ring of RING_ORDER) {
      expect(screen.getByTestId(`radar-region-${ring}`)).toBeTruthy();
    }
    fireEvent.mouseEnter(screen.getByTestId("radar-region-emerging"));
    expect(opacityOf("Newborn")).toBe("1");
    expect(ringOf("Newborn")).toBeTruthy();
    for (const key of ["Grower", "Holder", "Packed", "Fading"]) expect(opacityOf(key)).toBe("0.35");
  });

  it("mouse leave restores every dot, ring and wash — hover-only, nothing sticks", () => {
    renderBoard(regionBlips(), true);
    const region = screen.getByTestId("radar-region-enter");
    fireEvent.mouseEnter(region);
    fireEvent.mouseLeave(region);
    for (const key of ["Grower", ...OTHERS]) {
      expect(opacityOf(key)).toBe("1");
      expect(ringOf(key)).toBeNull();
    }
    expect(region.getAttribute("fill")).toBe("transparent");
    // A band CLICK zooms (see the click-to-zoom suite) — it must NEVER open a dossier:
    // only dots do that.
    fireEvent.click(region);
    expect(screen.queryByTestId("verdict-dossier")).toBeNull();
    expect(screen.getByTestId("radar-zoom-chip")).toBeTruthy();
  });

  it("dot hover takes precedence: the tooltip's single-dot emphasis wins, and the wash follows the dot's own band", () => {
    renderBoard(regionBlips(), true);
    fireEvent.mouseEnter(screen.getByTestId("radar-region-enter"));
    fireEvent.mouseEnter(dot("Packed"));
    // Existing dot-hover behavior, untouched: only the hovered dot stays full, EVEN the
    // hovered band's member dims, and no band ring draws while a dot is hovered.
    expect(opacityOf("Packed")).toBe("1");
    expect(opacityOf("Grower")).toBe("0.35");
    expect(ringOf("Grower")).toBeNull();
    expect(ringOf("Packed")).toBeNull();
    // The tooltip is the existing one.
    expect(screen.getByText(/Packed — Micro-genres/)).toBeTruthy();
    // The wash follows the DOT's band (the pointer is physically there now).
    expect(screen.getByTestId("radar-region-crowded").getAttribute("fill")).toMatch(/^color-mix/);
    expect(screen.getByTestId("radar-region-enter").getAttribute("fill")).toBe("transparent");
    // Leaving the dot hands emphasis back to the still-hovered band.
    fireEvent.mouseLeave(dot("Packed"));
    expect(opacityOf("Grower")).toBe("1");
    expect(ringOf("Grower")).toBeTruthy();
  });

  it("rail rows of the hovered band take the left-edge tick — never reordered or filtered", () => {
    renderBoard(regionBlips(), true);
    const rowKeys = () =>
      Array.from(screen.getByTestId("radar-rail-list").querySelectorAll("button[data-testid^='radar-row-']")).map(
        (el) => el.getAttribute("data-testid"),
      );
    const before = rowKeys();
    fireEvent.mouseEnter(screen.getByTestId("radar-region-enter"));
    expect(screen.getByTestId("radar-row-tag:Grower").getAttribute("data-region-tick")).toBe("enter");
    for (const key of OTHERS) {
      expect(screen.getByTestId(`radar-row-tag:${key}`).getAttribute("data-region-tick")).toBeNull();
    }
    expect(rowKeys()).toEqual(before); // same rows, same order — a reading aid only
    fireEvent.mouseLeave(screen.getByTestId("radar-region-enter"));
    expect(screen.getByTestId("radar-row-tag:Grower").getAttribute("data-region-tick")).toBeNull();
  });
});

describe("RadarBoard — click-to-zoom (the ring bands)", () => {
  // Three watch members + one member for two other bands.
  const zoomBlips = () => [
    makeBlip("Watcher A", { demand_trend_24m_pct: 10, opportunity_v2: 70 }),
    makeBlip("Watcher B", { demand_trend_24m_pct: 12, opportunity_v2: 55 }),
    makeBlip("Watcher C", { demand_trend_24m_pct: -12, opportunity_v2: 30 }),
    makeBlip("Grower", { demand_trend_24m_pct: 120, saturation_yoy: 0.05, opportunity_v2: 90 }),
    makeBlip("Fading", { demand_trend_24m_pct: -60, saturation_yoy: 0.05, opportunity_v2: 20 }),
  ];
  const WATCHERS = ["Watcher A", "Watcher B", "Watcher C"];
  const OTHERS = ["Grower", "Fading"];
  const dot = (key: string) => screen.queryByTestId(`radar-blip-tag:${key}`);
  const row = (key: string) => screen.queryByTestId(`radar-row-tag:${key}`);
  const zoomInto = (ring: string) => fireEvent.click(screen.getByTestId(`radar-region-${ring}`));
  const search = () => screen.getByTestId("radar-search") as HTMLInputElement;

  it("clicking a ring's empty area zooms: members only, the band fills the dial, ONE title", () => {
    renderBoard(zoomBlips(), true);
    zoomInto("watch");
    for (const key of WATCHERS) expect(dot(key)).toBeTruthy();
    for (const key of OTHERS) expect(dot(key)).toBeNull();
    // The other four bands are gone — a zoomed dial shows one band, at full radius.
    expect(screen.getByTestId("ring-band-watch")).toBeTruthy();
    expect(screen.queryByTestId("ring-band-enter")).toBeNull();
    expect(screen.queryByTestId("ring-band-declining")).toBeNull();
    // One title replaces the rim reading, with the exits spelled out…
    expect(screen.getByText("WATCH — ZOOMED")).toBeTruthy();
    expect(screen.getByText(/ESC · BACKGROUND CLICK/)).toBeTruthy();
    // …and band hover is disabled while zoomed (single-band view — moot).
    expect(screen.queryByTestId("radar-region-watch")).toBeNull();
    expect(screen.getByTestId("radar-zoom-exit")).toBeTruthy();
  });

  it("layoutBoard gives the zoomed band the whole dial and hides every non-member", () => {
    const layout = layoutBoard(zoomBlips(), { zoom: "watch" });
    expect(layout.geom.bands.map((b) => b.ring)).toEqual(["watch"]);
    expect(layout.geom.bands[0].r1).toBeCloseTo(layout.geom.R, 6);
    const byKey = new Map(layout.dots.map((d) => [d.key, d]));
    for (const key of WATCHERS) {
      const d = byKey.get(key)!;
      expect(d.hidden).toBe(false);
      // Spread across the WHOLE radius now — that is what the zoom buys.
      expect(d.radius).toBeGreaterThanOrEqual(layout.geom.r0);
      expect(d.radius).toBeLessThanOrEqual(layout.geom.R);
    }
    // Non-members are hidden, never repositioned lies — and their ring is untouched.
    for (const key of OTHERS) {
      expect(byKey.get(key)!.hidden).toBe(true);
      expect(byKey.get(key)!.region).toBe(byKey.get(key)!.verdict.ring);
    }
    // Zooming really does spread them: the WATCH members' own radial spread grows, because
    // the band they share now owns the whole dial instead of one fifth of it.
    const rest = layoutBoard(zoomBlips());
    const spread = (l: typeof layout) => {
      const rs = l.dots.filter((d) => WATCHERS.includes(d.key)).map((d) => d.radius);
      return Math.max(...rs) - Math.min(...rs);
    };
    expect(spread(layout)).toBeGreaterThan(spread(rest));
  });

  it("the rail filters to the zoomed ring: chip with honest count, recomputed groups, board ranks kept", () => {
    renderBoard(zoomBlips(), true);
    zoomInto("watch");
    const chip = screen.getByTestId("radar-zoom-chip");
    expect(chip.textContent).toContain("WATCH");
    expect(chip.textContent).toContain("3 niche");
    for (const key of WATCHERS) expect(row(key)).toBeTruthy();
    for (const key of OTHERS) expect(row(key)).toBeNull();
    // The rail header count is the filtered member count, not the plotted total.
    expect(screen.getByText("Verdicts").parentElement?.textContent).toContain("3");
  });

  it("search composes with the zoom filter — scoped placeholder, honest arithmetic, honest empty state", () => {
    renderBoard(zoomBlips(), true);
    zoomInto("watch");
    expect(search().placeholder).toContain("in WATCH");
    fireEvent.change(search(), { target: { value: "er b" } });
    expect(row("Watcher B")).toBeTruthy();
    expect(row("Watcher A")).toBeNull();
    expect(screen.getByText("1 of 3 match")).toBeTruthy();
    // A niche OUTSIDE the zoomed ring must never be smuggled in by the search.
    fireEvent.change(search(), { target: { value: "grower" } });
    const empty = screen.getByTestId("radar-search-empty");
    expect(empty.textContent).toContain("searched the 3 niches in WATCH");
    expect(row("Grower")).toBeNull();
  });

  it("dot-click precedence survives the zoom: a dot opens its dossier, and the zoom persists behind it", () => {
    renderBoard(zoomBlips(), true);
    zoomInto("watch");
    fireEvent.click(dot("Watcher A")!);
    expect(screen.getByTestId("verdict-dossier").textContent).toContain("Watcher A");
    fireEvent.click(screen.getByRole("button", { name: /back to all verdicts/i }));
    expect(screen.getByTestId("radar-zoom-chip")).toBeTruthy(); // still zoomed
    expect(dot("Grower")).toBeNull();
  });

  it("three exits — the chip's ✕, Escape, and the board-background click — all restore the full view", () => {
    renderBoard(zoomBlips(), true);
    const restored = () => {
      expect(screen.queryByTestId("radar-zoom-chip")).toBeNull();
      for (const key of [...WATCHERS, ...OTHERS]) expect(dot(key)).toBeTruthy();
      expect(screen.getByTestId("radar-region-watch")).toBeTruthy();
      expect(screen.getByTestId("ring-band-declining")).toBeTruthy();
    };
    zoomInto("watch");
    fireEvent.click(screen.getByTestId("radar-zoom-chip"));
    restored();
    zoomInto("watch");
    fireEvent.keyDown(document, { key: "Escape" });
    restored();
    zoomInto("watch");
    fireEvent.click(screen.getByTestId("radar-zoom-exit"));
    restored();
  });

  it("Esc clears the search text first; only the NEXT Esc exits the zoom", () => {
    renderBoard(zoomBlips(), true);
    zoomInto("watch");
    fireEvent.change(search(), { target: { value: "er b" } });
    fireEvent.keyDown(search(), { key: "Escape" });
    expect(search().value).toBe("");
    expect(screen.getByTestId("radar-zoom-chip")).toBeTruthy(); // zoom survived the clear
    fireEvent.keyDown(search(), { key: "Escape" });
    expect(screen.queryByTestId("radar-zoom-chip")).toBeNull();
  });

  it("every ring zooms to itself, and the URL vocabulary is exactly RING_ORDER", () => {
    for (const ring of RING_ORDER) {
      const layout = layoutBoard(zoomBlips(), { zoom: ring });
      expect(layout.geom.bands.map((b) => b.ring)).toEqual([ring]);
      expect(layout.dots.filter((d) => !d.hidden).every((d) => d.verdict.ring === ring)).toBe(true);
    }
  });
});

/**
 * A1 — WHICH LABELS PAINT OVER THE DATA, AND WHICH DELIBERATELY DO NOT.
 *
 * Measured on production /radar (2026-09-01): the XY plate's "FLOOD BAR" label was being
 * erased by the dense cluster sitting on the very line it named, because SVG paints in
 * document order and the label lived in the first group. The rule that came out of it —
 * small, unique, load-bearing labels paint LAST — still holds, and it now applies to the
 * dial's RIM LABELS and its ZOOM TITLE.
 *
 * The BAND CAPTIONS are the deliberate exception, and the exception is the point: they are
 * 20-26px wallpaper at ~34% opacity, one per band, saying the same word the rail group
 * header, the legend and the hue key already say. Painting them over 80 numbered dots would
 * spend the data to protect a label that is redundant three times over, so they paint under.
 *
 * These assert paint ORDER rather than pixels, because document order is the whole
 * mechanism: no viewport, no font metric and no dataset can make a group that comes first
 * paint last.
 */
describe("RadarBoard — label paint order (A1)", () => {
  /** A node's index in the dial's own document order == its paint order. */
  function paintIndex(container: HTMLElement, node: Element): number {
    const plate = container.querySelector('svg[role="img"]')!;
    return Array.from(plate.querySelectorAll("*")).indexOf(node);
  }

  it("puts the rim sector label AFTER every blip dot", () => {
    const { container } = renderBoard(
      [
        makeBlip("On The Bar A", { demand_trend_24m_pct: 5, saturation_yoy: 0.15, opportunity_v2: 60 }),
        makeBlip("On The Bar B", { demand_trend_24m_pct: 12, saturation_yoy: 0.16, opportunity_v2: 58 }),
        makeBlip("Roguelike Deckbuilder", REFERENCE),
      ],
      true,
    );
    const label = screen.getByTestId("radar-sector-label-micro");
    const dots = Array.from(container.querySelectorAll('circle[data-testid^="radar-blip-"]'));
    expect(dots.length).toBeGreaterThan(0);
    for (const d of dots) {
      expect(paintIndex(container, label)).toBeGreaterThan(paintIndex(container, d));
    }
  });

  it("puts the zoom title after the dots too — it names the only band on screen", () => {
    const { container } = renderBoard(
      [
        makeBlip("Watcher A", { demand_trend_24m_pct: 10, opportunity_v2: 70 }),
        makeBlip("Watcher B", { demand_trend_24m_pct: 12, opportunity_v2: 55 }),
      ],
      true,
    );
    fireEvent.click(screen.getByTestId("radar-region-watch"));
    const lastDot = Array.from(container.querySelectorAll('circle[data-testid^="radar-blip-"]')).pop()!;
    expect(paintIndex(container, screen.getByText("WATCH — ZOOMED"))).toBeGreaterThan(
      paintIndex(container, lastDot),
    );
  });

  it("deliberately paints the BAND CAPTIONS under the dots — wallpaper must not eat the data", () => {
    const { container } = renderBoard([makeBlip("Roguelike Deckbuilder", REFERENCE)], true);
    const firstDot = container.querySelector('circle[data-testid^="radar-blip-"]')!;
    for (const ring of RING_ORDER) {
      expect(paintIndex(container, screen.getByTestId(`ring-caption-${ring}`))).toBeLessThan(
        paintIndex(container, firstDot),
      );
    }
    // …and so are the band circles themselves: a gridline belongs under the data.
    expect(paintIndex(container, screen.getByTestId("ring-band-enter"))).toBeLessThan(
      paintIndex(container, firstDot),
    );
  });

  it("keeps the annotation layer pointer-inert, so no dot loses its hover or click", () => {
    renderBoard([makeBlip("Roguelike Deckbuilder", REFERENCE)], true);
    expect(screen.getByTestId("ring-annotations").getAttribute("pointer-events")).toBe("none");
    fireEvent.click(screen.getByTestId("radar-sector-label-micro"));
    expect(screen.queryByTestId("verdict-dossier")).toBeNull();
    // The dot underneath still opens its dossier.
    fireEvent.click(screen.getByTestId("radar-blip-tag:Roguelike Deckbuilder"));
    expect(screen.getByTestId("verdict-dossier")).toBeTruthy();
  });

  it("keeps a knockout halo on the label, so glyphs stay legible where they cross a dot", () => {
    renderBoard([makeBlip("Roguelike Deckbuilder", REFERENCE)], true);
    const label = screen.getByTestId("radar-sector-label-micro");
    expect(label.style.paintOrder).toBe("stroke");
    expect(Number(label.style.strokeWidth)).toBeGreaterThan(0);
  });
});

/**
 * THE DEEP-DIVE AFFORDANCE (2026-09-10, user: "Button to go deeper into the niche is super
 * small and almost not visible"). It was a 13px plain text link at the very bottom of the
 * dossier, under the raw-context line. It is now the dossier's PRIMARY ACTION: a filled
 * brand button in the page's own primary-action language, full width, above the context
 * line. The route and the analytics event are unchanged — this is a presentation fix, and
 * a regression that quietly turned it back into a text link would be invisible otherwise.
 */
describe("RadarBoard — the deep dive is a primary button", () => {
  const open = () => {
    renderBoard([makeBlip("Roguelike Deckbuilder", REFERENCE)], true);
    fireEvent.click(screen.getByTestId("radar-blip-tag:Roguelike Deckbuilder"));
    return screen.getByTestId("radar-deep-dive");
  };

  it("is filled with the brand colour and sized like the page's other primary actions", () => {
    const cta = open();
    expect(cta.className).toContain("bg-brand");
    expect(cta.className).toContain("text-brand-fg");
    expect(cta.className).toContain("font-semibold");
    expect(cta.className).toContain("w-full");
    // Not the old bare-text link: it has a filled ground and real button padding.
    expect(cta.className).toMatch(/\bpx-\d/);
    expect(cta.className).toMatch(/\bpy-\d/);
    expect(cta.className).not.toContain("text-[13px] text-brand ");
  });

  it("still routes to the niche's detail page, unchanged", () => {
    const cta = open();
    expect(cta.getAttribute("href")).toBe("/niches/tag/Roguelike%20Deckbuilder");
    expect(cta.textContent).toContain("Open deep dive");
  });

  it("sits ABOVE the raw-context line — the way out, not a footnote after it", () => {
    const cta = open();
    const dossier = screen.getByTestId("verdict-dossier");
    const context = Array.from(dossier.querySelectorAll("span")).find((s) =>
      (s.textContent ?? "").startsWith("reviews 24m"),
    )!;
    expect(cta.compareDocumentPosition(context) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
