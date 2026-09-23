import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";

import { OpportunityBreakdown } from "./OpportunityBreakdown";
import type { NicheRow } from "../lib/api";

afterEach(cleanup);

// Colony Sim as the docs' worked example prints it (mart 20260831, 24m · ≥50), plus the raw
// inputs a /api/niches row carries alongside the parts.
const COLONY: Partial<NicheRow> = {
  opportunity_v2: 23.75,
  momentum: 38.92,
  market_pull: 73.7,
  revenue_spread: 100,
  quality_gap: 89.25,
  supply_room: 0,
  supply_brake: 0.35,
  winner_concentration: 0.62,
  beatable_share: 0.41,
  demand_emerging: false,
};

const openTip = (name: string) => {
  act(() => screen.getByRole("button", { name }).focus());
  return screen.getByRole("tooltip").textContent ?? "";
};

describe("OpportunityBreakdown — full", () => {
  it("leads with the bearish reading, before the numbers that add up to it", () => {
    render(<OpportunityBreakdown row={COLONY} />);
    const section = screen.getByTestId("opportunity-breakdown");
    const headline = screen.getByTestId("opportunity-headline");
    expect(headline.textContent).toMatch(/^Held back by the supply brake \(×0\.35\)/);
    // The headline precedes the table in document order.
    const table = within(section).getByRole("table");
    expect(headline.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows every part's value, weight and points, then the core, the brake and the score", () => {
    render(<OpportunityBreakdown row={COLONY} />);
    const rows = within(screen.getByRole("table")).getAllByRole("row").map((r) => r.textContent?.replace(/\s+/g, " ").trim());
    expect(rows).toContain("Momentum38.9× 0.4015.6");
    expect(rows).toContain("Market pull73.7× 0.2216.2");
    expect(rows.some((r) => r?.startsWith("Revenue spread100.0capped at 100× 0.2020.0"))).toBe(true);
    expect(rows).toContain("Quality gap89.3× 0.1816.1");
    expect(rows).toContain("Core — weighted mean of the parts67.8");
    expect(rows.some((r) => r?.startsWith("× Supply brakefull brake×0.35"))).toBe(true);
    expect(rows).toContain("= Opportunity score23.8");
  });

  it("works each part and the total through this row's own numbers", () => {
    render(<OpportunityBreakdown row={COLONY} />);
    expect(openTip("About Opportunity score")).toContain(
      "(0.40 × 38.92 + 0.22 × 73.70 + 0.20 × 100.00 + 0.18 × 89.25) × 0.35 = 23.75",
    );
    expect(openTip("About Revenue spread")).toContain("100 × clamp( (1 − 0.6200) ÷ 0.30, 0, 1 ) = 100.00");
    expect(openTip("About Quality gap")).toContain("rank of a 41% beatable share among the niches in this cut = 89.25");
    expect(openTip("About Supply brake")).toContain("0.35 + 0.65 × 0.00 ÷ 100 = ×0.35");
  });

  it("flags unscored parts and the missing brake, and says the weights were rescaled", () => {
    render(
      <OpportunityBreakdown
        row={{ ...COLONY, momentum: null, supply_room: null, supply_brake: 1, demand_emerging: true, opportunity_v2: 87.13 }}
      />,
    );
    const table = screen.getByRole("table");
    expect(table.textContent).not.toContain("doesn't add up"); // (16.214 + 20 + 16.065) ÷ 0.60 × 1 = 87.13
    const momentumRow = within(table).getByRole("rowheader", { name: /Momentum/ }).closest("tr")!;
    expect(momentumRow.textContent).toContain("not scored");
    expect(momentumRow.textContent).toContain("—");
    expect(table.textContent).toContain("unknown → ×1.00");
    expect(screen.getByTestId("opportunity-breakdown").textContent).toMatch(
      /Momentum wasn't scored, so the other weights are rescaled to sum to 1 \(each ÷ 0\.60\)/,
    );
  });

  it("flags a served score its own parts don't reproduce", () => {
    render(<OpportunityBreakdown row={{ ...COLONY, opportunity_v2: 30 }} />);
    expect(screen.getByRole("table").textContent).toContain("doesn't add up");
    expect(openTip("About the Opportunity score total")).toMatch(/These parts give 23\.75, but the served score is 30\.00/);
  });

  it("says so, instead of drawing zeros, for a row that predates the parts", () => {
    render(<OpportunityBreakdown row={{ opportunity_v2: 41.2, quality_gap: 50 }} />);
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByTestId("opportunity-headline").textContent).toMatch(/^No breakdown/);
  });
});

describe("OpportunityBreakdown — compact (a Finder row)", () => {
  it("fits a row: mini bars, the brake and the score, with the full sum behind the ⓘ", () => {
    render(<OpportunityBreakdown row={COLONY} variant="compact" />);
    const el = screen.getByTestId("opportunity-breakdown-compact");
    expect(el.textContent).toContain("×0.35");
    expect(el.textContent).toContain("23.8");
    // Screen readers get the parts as words, not four unlabelled bars.
    expect(el.querySelector(".sr-only")!.textContent).toBe(
      "Opportunity score 23.8, Momentum 38.9, Market pull 73.7, Revenue spread 100.0, Quality gap 89.3, supply brake ×0.35",
    );
    const tip = openTip("About Opportunity breakdown");
    expect(tip).toMatch(/Held back by the supply brake/);
    expect(tip).toContain("Momentum 38.9 × 0.40 = 15.6");
    expect(tip).toContain("× Supply brake 0.35 (full brake)");
  });

  it("contains its absolutely-positioned sr-only summary (it must not widen the page from inside a table scroller)", () => {
    // Measured in Chromium at 390px: without a positioned wrapper the sr-only span anchored to
    // the page, not the (unpositioned) TableScroll, and scrolled the whole body sideways by 65px.
    render(<OpportunityBreakdown row={COLONY} variant="compact" />);
    expect(screen.getByTestId("opportunity-breakdown-compact").className.split(" ")).toContain("relative");
    cleanup();
    render(<OpportunityBreakdown row={COLONY} />);
    expect(screen.getByRole("table").className.split(" ")).toContain("relative");
  });

  it("marks a row without parts rather than drawing empty bars", () => {
    render(<OpportunityBreakdown row={{ opportunity_v2: 41.2 }} variant="compact" />);
    expect(screen.getByTestId("opportunity-breakdown-compact").textContent).toBe("41.2no parts");
  });
});
