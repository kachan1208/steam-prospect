import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";

import { StaggeredTick, needsStaggeredAxis } from "./LaunchShapeBars";

/**
 * A10 — the launch-shape x-axis ran its labels together at phone widths: /timing @390
 * printed `4–6m7–12m`, because with `interval={0}` all seven windows share one row and
 * the gap between those two collapsed to 1px.
 *
 * The widths below are measured, not chosen: on production 2026-09-01 the chart's
 * container was 274px at 390 (1px gap — collision), 292px at 1440 where /timing lays the
 * charts out four to a row (3px — no better), and 417px at 1024 where the same axis is
 * comfortable (21px). Note the ordering: 1440 is NARROWER than 1024, which is why the fix
 * keys off the chart's own measured width and not a viewport breakpoint.
 */
describe("needsStaggeredAxis", () => {
  it("staggers where the labels were measured to collide", () => {
    expect(needsStaggeredAxis(274)).toBe(true); // /timing @390 — the reported `4–6m7–12m`
    expect(needsStaggeredAxis(292)).toBe(true); // /timing @1440 — 3px apart, four to a row
  });

  it("leaves the axis alone where it already had room", () => {
    expect(needsStaggeredAxis(417)).toBe(false); // /timing @1024 — 21px apart
    expect(needsStaggeredAxis(900)).toBe(false);
  });

  it("does not stagger before the container has been measured", () => {
    // Width 0 is the pre-measure state; guessing "narrow" there would flash a two-row
    // axis on every mount at desktop widths.
    expect(needsStaggeredAxis(0)).toBe(false);
  });
});

describe("StaggeredTick", () => {
  it("alternates rows so neighbouring labels never share one", () => {
    const dy = [0, 1, 2, 3].map((index) => {
      const { container } = render(
        <svg>
          <StaggeredTick x={10} y={20} index={index} payload={{ value: "7–12m" }} />
        </svg>,
      );
      return container.querySelector("text")?.getAttribute("dy");
    });
    expect(dy).toEqual(["11", "23", "11", "23"]);
  });

  it("still renders the label, so staggering never costs a window", () => {
    const { container } = render(
      <svg>
        <StaggeredTick x={10} y={20} index={5} payload={{ value: "4–6m" }} />
      </svg>,
    );
    const text = container.querySelector("text");
    expect(text?.textContent).toBe("4–6m");
    // recharts' own class has to survive: index.css styles ticks through it.
    expect(text?.getAttribute("class")).toBe("recharts-cartesian-axis-tick-value");
  });
});
