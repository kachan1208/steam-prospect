import { useState } from "react";
import { MemoryRouter } from "react-router-dom";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import { RadarBoard, type RadarBoardBlip, type RadarRegion } from "../components/RadarBoard";
import type { NicheRow } from "../lib/api";
import { radarSector, radarVerdictTrace } from "../lib/radarVerdict";

/**
 * THE PARITY ORACLE for the niche pages (2026-09-09). The user's complaint was that the
 * niche page and the Radar looked like two models; the fix makes the niche pages print the
 * board tooltip's rows through lib/radarVerdict.ts. That equality must be pinned against the
 * BOARD'S OWN RENDERING, not against a re-implementation of it — so this helper builds the
 * blip pages/Radar.tsx builds for a list row (its `pool` memo, verbatim), renders a real
 * RadarBoard around it, hovers the dot, and reads the tooltip's label -> value rows back.
 * A page test then asserts it renders those exact strings. If RadarBoard.tsx ever changes a
 * format, the niche pages fail loudly instead of drifting.
 */

/** A list row with every field the Radar's pool builder reads. Callers spread overrides. */
export function radarListRow(over: Partial<NicheRow> & { key: string }): NicheRow {
  return {
    dimension: "tag",
    window: "24m",
    min_reviews: 50,
    n_games: 86,
    n_recent: 30,
    median_rev: 100_000,
    p25_rev: 10_000,
    p75_rev: 500_000,
    p90_rev: 9_700_000,
    median_reviews: 120,
    median_price: 14.99,
    median_positive_ratio: 0.9,
    median_owners: 30_000,
    total_owners: 4_000_000,
    total_rev: 60_000_000,
    total_reviews: 400_000,
    market_size: 60,
    recent_velocity: 1,
    self_pub_share: 0.5,
    winner_concentration: 0.62,
    hit_rate_200k: 0.3,
    hit_rate_500k: 0.2,
    beatable_share: 0.4,
    saturation_yoy: -0.074,
    n_recent_year: 63,
    n_prior_year: 68,
    demand: 60,
    competition: 40,
    quality_gap: 87,
    opportunity: 60,
    opportunity_v2: 86.69,
    decline_gate: 1,
    entrant_ratio: 1.2,
    solo_viability: 0.98,
    tier: "micro",
    reviews_24m: 120_000,
    reviews_prev_24m: 69_000,
    demand_trend_24m_pct: 74.1,
    reviews_24m_new_share: 0.3,
    demand_emerging: false,
    ...over,
  };
}

/** pages/Radar.tsx's `pool` mapping for one row — the same radarVerdictTrace call with the
 * same inputs, so the blip carries the ring the board would draw. */
export function radarBlipFor(row: NicheRow): RadarBoardBlip {
  const sector = radarSector(row.dimension, row.tier);
  if (!sector) throw new Error(`${row.dimension}:${row.key} has no Radar class — not a board row`);
  const demandTrendPct = row.demand_trend_24m_pct ?? null;
  const demandEmerging = row.demand_emerging === true;
  const { checks, ...verdict } = radarVerdictTrace({
    demand_trend_24m_pct: demandTrendPct,
    demand_emerging: demandEmerging,
    saturation_yoy: row.saturation_yoy,
    winner_concentration: row.winner_concentration,
    opportunity_v2: row.opportunity_v2,
    entrant_ratio: row.entrant_ratio,
    solo_viability: row.solo_viability ?? null,
    self_published_share: row.self_published_share ?? null,
    indie_share: row.indie_share ?? null,
    med_playtime_h: row.med_playtime_h ?? null,
    reviews_24m: row.reviews_24m ?? null,
    reviews_prev_24m: row.reviews_prev_24m ?? null,
    reviews_24m_new_share: row.reviews_24m_new_share ?? null,
  });
  return {
    dimension: row.dimension,
    key: row.key,
    tier: row.tier,
    sector,
    n_games: row.n_games,
    p90_rev: row.p90_rev ?? null,
    opportunity_v2: row.opportunity_v2,
    demandTrendPct,
    saturationYoy: row.saturation_yoy,
    demandEmerging,
    reviews24m: row.reviews_24m ?? null,
    reviewsPrev24m: row.reviews_prev_24m ?? null,
    solo_viability: row.solo_viability ?? null,
    verdict,
    trace: checks,
  };
}

function Harness({ blips }: { blips: RadarBoardBlip[] }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [zoom, setZoom] = useState<RadarRegion | null>(null);
  return (
    <MemoryRouter>
      <RadarBoard
        blips={blips}
        pool={blips}
        plotCap={blips.length}
        soloOnly={false}
        emphasis={null}
        selectedId={selectedId}
        onSelect={setSelectedId}
        zoom={zoom}
        onZoom={setZoom}
      />
    </MemoryRouter>
  );
}

export interface RadarTooltipRead {
  /** label -> value, e.g. rows["Demand 24m"] === "▲ +74.1%". */
  rows: Record<string, string>;
  /** The dot's fill attribute — the board's colour token for this verdict. */
  dotFill: string | null;
}

/**
 * Render the board with this one row, hover its dot, read the tooltip, unmount. Returns the
 * tooltip's rows keyed by label plus the dot's fill token. Cleans up after itself so the
 * caller can render its own page next.
 */
export function readRadarTooltip(row: NicheRow): RadarTooltipRead {
  const blip = radarBlipFor(row);
  render(<Harness blips={[blip]} />);
  const dot = screen.getByTestId(`radar-blip-${blip.dimension}:${blip.key}`);
  fireEvent.mouseEnter(dot);
  // The tooltip is the TooltipPanel whose title names the niche and its class.
  const title = screen.getByText(new RegExp(`^1\\. ${blip.key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} — `));
  const panel = title.parentElement!;
  const rows: Record<string, string> = {};
  for (const line of Array.from(panel.querySelectorAll(":scope > div > div"))) {
    const spans = within(line as HTMLElement).getAllByText(/./, { selector: "span" });
    // [swatch?, label, value] — the swatch span has no text and is skipped by the matcher.
    const label = spans[0]?.textContent ?? "";
    const value = spans[1]?.textContent ?? "";
    rows[label] = value;
  }
  const dotFill = dot.getAttribute("fill");
  cleanup();
  return { rows, dotFill };
}
