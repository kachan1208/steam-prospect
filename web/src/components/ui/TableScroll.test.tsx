import { describe, expect, it } from "vitest";
import { fireEvent, render } from "@testing-library/react";

import { TableScroll } from "./TableScroll";

/**
 * The scroll affordance has to appear EXACTLY when content is hidden (B1).
 *
 * The numbers below are the real production measurements from 2026-09-01 that motivated
 * the component, so a change that breaks the cue breaks them: /studios @390 scrolls
 * 1139px of table through a 340px viewport (799px — 70% — invisible), /studios @1024
 * scrolls the same 1139px through 942px (197px invisible), and /studios @1440 fits.
 *
 * jsdom has no layout, so scrollWidth/clientWidth/scrollLeft are stubbed per element —
 * that is the only input the component reads, and stubbing them is what lets the *rule*
 * ("cue iff clipped") be tested rather than a snapshot of markup.
 */
function stubMetrics(el: HTMLElement, scrollWidth: number, clientWidth: number, scrollLeft = 0) {
  Object.defineProperty(el, "scrollWidth", { configurable: true, value: scrollWidth });
  Object.defineProperty(el, "clientWidth", { configurable: true, value: clientWidth });
  Object.defineProperty(el, "scrollLeft", { configurable: true, writable: true, value: scrollLeft });
  // The component re-measures on scroll; firing it is how the stub reaches it.
  fireEvent.scroll(el);
}

function renderScroller() {
  const { container } = render(
    <TableScroll>
      <table>
        <tbody>
          <tr>
            <td>Total est. revenue</td>
          </tr>
        </tbody>
      </table>
    </TableScroll>,
  );
  return container.firstElementChild as HTMLElement;
}

describe("TableScroll — the horizontal scroll affordance", () => {
  it("carries the shared class so one CSS rule serves every table", () => {
    expect(renderScroller().classList.contains("table-scroll")).toBe(true);
  });

  it("flags hidden content on the right — /studios @390: 1139px of row through 340px", () => {
    const el = renderScroller();
    stubMetrics(el, 1139, 340, 0);
    expect(el.getAttribute("data-hidden")).toBe("right");
  });

  it("still flags it at 1024, where 197px of the same row is off-screen", () => {
    const el = renderScroller();
    stubMetrics(el, 1139, 942, 0);
    expect(el.getAttribute("data-hidden")).toBe("right");
  });

  it("flags BOTH sides once the reader has scrolled into the middle", () => {
    const el = renderScroller();
    stubMetrics(el, 1139, 340, 400);
    expect(el.getAttribute("data-hidden")).toBe("both");
  });

  it("flags only the left once the reader has reached the end", () => {
    const el = renderScroller();
    stubMetrics(el, 1139, 340, 799);
    expect(el.getAttribute("data-hidden")).toBe("left");
  });

  it("stays silent when the table fits — /studios @1440 must look untouched", () => {
    const el = renderScroller();
    stubMetrics(el, 1139, 1139, 0);
    expect(el.getAttribute("data-hidden")).toBeNull();
  });

  it("treats a sub-pixel overhang as fitting, so a complete table never fakes a cue", () => {
    const el = renderScroller();
    stubMetrics(el, 341, 340, 0);
    expect(el.getAttribute("data-hidden")).toBeNull();
  });
});
