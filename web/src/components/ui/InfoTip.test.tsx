import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

import {
  INFOTIP_CLOSE_DELAY,
  INFOTIP_OPEN_DELAY,
  InfoTip,
  TIP_GAP,
  TIP_MARGIN,
  computeTipPosition,
} from "./InfoTip";
import { HeaderLabel } from "./HeaderLabel";
import { TableScroll } from "./TableScroll";
import { GLOSSARY } from "../../lib/glossary";

/**
 * jsdom has no PointerEvent, so `fireEvent.pointerDown(el, { pointerType: "touch" })` would
 * build a plain Event and drop pointerType — and pointerType is exactly what separates a
 * mouse hover from a finger. A minimal MouseEvent subclass carries it through to React.
 */
class TestPointerEvent extends MouseEvent {
  pointerType: string;
  constructor(type: string, init: MouseEventInit & { pointerType?: string } = {}) {
    super(type, init);
    this.pointerType = init.pointerType ?? "mouse";
  }
}
const hadPointerEvent = "PointerEvent" in window;
beforeAll(() => {
  (window as unknown as { PointerEvent: unknown }).PointerEvent = TestPointerEvent;
});
afterAll(() => {
  if (!hadPointerEvent) delete (window as unknown as { PointerEvent?: unknown }).PointerEvent;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const RELEASES = GLOSSARY.saturation_yoy;
const trigger = () => screen.getByRole("button", { name: `About ${RELEASES.label}` });
const tooltip = () => screen.queryByRole("tooltip");

function tap(el: Element) {
  fireEvent.pointerDown(el, { pointerType: "touch" });
  act(() => (el as HTMLElement).focus());
  fireEvent.click(el);
}

describe("InfoTip — a real, accessible control", () => {
  it("renders a button named for the metric, collapsed, with no panel in the DOM", () => {
    render(<InfoTip term="saturation_yoy" />);
    const btn = trigger();
    expect(btn.tagName).toBe("BUTTON");
    expect(btn.getAttribute("type")).toBe("button");
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(btn.hasAttribute("aria-describedby")).toBe(false);
    expect(tooltip()).toBeNull();
  });

  it("opens on KEYBOARD FOCUS and points aria-describedby at the tooltip", () => {
    render(<InfoTip term="saturation_yoy" />);
    act(() => trigger().focus());
    const tip = tooltip()!;
    expect(tip).not.toBeNull();
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(trigger().getAttribute("aria-describedby")).toBe(tip.id);
    expect(tip.textContent).toContain(RELEASES.label);
    expect(tip.textContent).toContain(RELEASES.meaning);
    expect(tip.textContent).toContain(RELEASES.formula);
  });

  it("closes on blur", () => {
    render(<InfoTip term="saturation_yoy" />);
    act(() => trigger().focus());
    expect(tooltip()).not.toBeNull();
    act(() => trigger().blur());
    expect(tooltip()).toBeNull();
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("closes on Esc and leaves focus on the trigger", () => {
    render(<InfoTip term="saturation_yoy" />);
    act(() => trigger().focus());
    fireEvent.keyDown(trigger(), { key: "Escape" });
    expect(tooltip()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("Esc closes only the tooltip — a sheet listening behind it doesn't also close", () => {
    const behind = vi.fn();
    document.addEventListener("keydown", behind);
    try {
      render(<InfoTip term="saturation_yoy" />);
      act(() => trigger().focus());
      fireEvent.keyDown(trigger(), { key: "Escape" });
      expect(behind).not.toHaveBeenCalled();
      fireEvent.keyDown(trigger(), { key: "Escape" }); // nothing open now: passes through
      expect(behind).toHaveBeenCalledTimes(1);
    } finally {
      document.removeEventListener("keydown", behind);
    }
  });

  it("opens on mouse HOVER after the intent delay, and closes after the pointer leaves", () => {
    vi.useFakeTimers();
    render(<InfoTip term="saturation_yoy" />);
    fireEvent.pointerEnter(trigger(), { pointerType: "mouse" });
    expect(tooltip()).toBeNull(); // a pass-over doesn't flash a panel
    act(() => vi.advanceTimersByTime(INFOTIP_OPEN_DELAY));
    expect(tooltip()).not.toBeNull();
    fireEvent.pointerLeave(trigger(), { pointerType: "mouse" });
    expect(tooltip()).not.toBeNull(); // grace period to reach the panel
    act(() => vi.advanceTimersByTime(INFOTIP_CLOSE_DELAY));
    expect(tooltip()).toBeNull();
  });

  it("keeps the panel open while the pointer travels into it (hoverable, WCAG 1.4.13)", () => {
    vi.useFakeTimers();
    render(<InfoTip term="saturation_yoy" />);
    fireEvent.pointerEnter(trigger(), { pointerType: "mouse" });
    act(() => vi.advanceTimersByTime(INFOTIP_OPEN_DELAY));
    fireEvent.pointerLeave(trigger(), { pointerType: "mouse" });
    fireEvent.pointerEnter(tooltip()!, { pointerType: "mouse" });
    act(() => vi.advanceTimersByTime(INFOTIP_CLOSE_DELAY * 3));
    expect(tooltip()).not.toBeNull();
    fireEvent.pointerLeave(tooltip()!, { pointerType: "mouse" });
    act(() => vi.advanceTimersByTime(INFOTIP_CLOSE_DELAY));
    expect(tooltip()).toBeNull();
  });

  it("a pass-over that leaves before the delay never opens it", () => {
    vi.useFakeTimers();
    render(<InfoTip term="saturation_yoy" />);
    fireEvent.pointerEnter(trigger(), { pointerType: "mouse" });
    fireEvent.pointerLeave(trigger(), { pointerType: "mouse" });
    act(() => vi.advanceTimersByTime(INFOTIP_OPEN_DELAY * 3));
    expect(tooltip()).toBeNull();
  });

  it("a TAP opens and pins it — the focus the tap causes doesn't race the click shut", () => {
    render(<InfoTip term="saturation_yoy" />);
    tap(trigger());
    expect(tooltip()).not.toBeNull();
    // A finger's synthetic pointerleave must not close a pinned panel.
    fireEvent.pointerLeave(trigger(), { pointerType: "touch" });
    expect(tooltip()).not.toBeNull();
    // A second tap closes it.
    fireEvent.pointerDown(trigger(), { pointerType: "touch" });
    fireEvent.click(trigger());
    expect(tooltip()).toBeNull();
  });

  it("a touch pointerenter is not a hover", () => {
    vi.useFakeTimers();
    render(<InfoTip term="saturation_yoy" />);
    fireEvent.pointerEnter(trigger(), { pointerType: "touch" });
    act(() => vi.advanceTimersByTime(INFOTIP_OPEN_DELAY * 3));
    expect(tooltip()).toBeNull();
  });

  it("a mouse CLICK pins it: moving away no longer closes it", () => {
    vi.useFakeTimers();
    render(<InfoTip term="saturation_yoy" />);
    fireEvent.pointerEnter(trigger(), { pointerType: "mouse" });
    act(() => vi.advanceTimersByTime(INFOTIP_OPEN_DELAY));
    fireEvent.pointerDown(trigger(), { pointerType: "mouse" });
    fireEvent.click(trigger()); // already open by hover: the click pins, it doesn't close
    expect(tooltip()).not.toBeNull();
    fireEvent.pointerLeave(trigger(), { pointerType: "mouse" });
    act(() => vi.advanceTimersByTime(INFOTIP_CLOSE_DELAY * 3));
    expect(tooltip()).not.toBeNull();
  });

  it("a press anywhere outside closes it; a press inside the panel doesn't", () => {
    render(<InfoTip term="saturation_yoy" />);
    tap(trigger());
    fireEvent.pointerDown(tooltip()!, { pointerType: "mouse" });
    expect(tooltip()).not.toBeNull();
    fireEvent.pointerDown(document.body, { pointerType: "mouse" });
    expect(tooltip()).toBeNull();
  });

  it("never activates the tile, row or header it sits in", () => {
    const onClick = vi.fn();
    const onKeyDown = vi.fn();
    render(
      <div onClick={onClick} onKeyDown={onKeyDown}>
        <InfoTip term="saturation_yoy" />
      </div>,
    );
    fireEvent.click(trigger());
    fireEvent.keyDown(trigger(), { key: "Enter" });
    fireEvent.keyDown(trigger(), { key: " " });
    fireEvent.click(tooltip()!); // React bubbles portal events through the component tree
    expect(onClick).not.toHaveBeenCalled();
    expect(onKeyDown).not.toHaveBeenCalled();
  });

  it("renders the row's worked numbers and flags a sentinel", () => {
    render(<InfoTip term="saturation_yoy" worked="(176 − 190) ÷ 190 = −7.4%" sentinel="floored to 0 — no releases last year" />);
    act(() => trigger().focus());
    const text = tooltip()!.textContent ?? "";
    expect(text).toContain("With these numbers");
    expect(text).toContain("(176 − 190) ÷ 190 = −7.4%");
    expect(text).toContain("Flagged value");
    expect(text).toContain("floored to 0 — no releases last year");
  });

  it("explicit props override the glossary, and nothing renders without content", () => {
    const { container } = render(<InfoTip />);
    expect(container.innerHTML).toBe("");
    cleanup();
    render(<InfoTip term="saturation_yoy" label="Pipeline" meaning="Custom words." ariaLabel="Explain the pipeline" />);
    const btn = screen.getByRole("button", { name: "Explain the pipeline" });
    act(() => btn.focus());
    expect(tooltip()!.textContent).toContain("Pipeline");
    expect(tooltip()!.textContent).toContain("Custom words.");
    expect(tooltip()!.textContent).toContain(RELEASES.formula); // non-overridden fields still come from the glossary
  });

  it("never shifts layout: a fixed-size trigger either way, the panel out of flow in a portal", () => {
    const { container } = render(<InfoTip term="saturation_yoy" />);
    const closedClass = trigger().className;
    act(() => trigger().focus());
    expect(trigger().className.includes("h-3.5 w-3.5")).toBe(true);
    expect(closedClass.includes("h-3.5 w-3.5")).toBe(true);
    const tip = tooltip()!;
    expect(container.contains(tip)).toBe(false);
    expect(tip.parentElement).toBe(document.body);
    expect(tip.className.split(" ")).toContain("fixed");
  });

  it("escapes a table's overflow scroller when it sits in a header cell", () => {
    render(
      <TableScroll>
        <table>
          <thead>
            <tr>
              <th>
                <HeaderLabel term="p90_rev" />
              </th>
            </tr>
          </thead>
        </table>
      </TableScroll>,
    );
    const btn = screen.getByRole("button", { name: `About ${GLOSSARY.p90_rev.label}` });
    act(() => btn.focus());
    const scroller = document.querySelector(".table-scroll")!;
    expect(scroller.contains(tooltip())).toBe(false);
  });
});

describe("computeTipPosition — stays inside the viewport", () => {
  const PHONE = { width: 390, height: 844 };
  const rect = (left: number, top: number, size = 14) => ({ left, top, bottom: top + size, width: size, height: size });

  it("centres the panel under its trigger when there is room", () => {
    const p = computeTipPosition(rect(188, 100), { width: 200, height: 120 }, PHONE);
    expect(p.placement).toBe("bottom");
    expect(p.top).toBe(114 + TIP_GAP);
    expect(p.left).toBe(188 + 7 - 100);
  });

  it("clamps to the margin at the right edge of a 390px phone", () => {
    const p = computeTipPosition(rect(372, 100), { width: 320, height: 120 }, PHONE);
    expect(p.left + 320).toBeLessThanOrEqual(390 - TIP_MARGIN);
    expect(p.left).toBe(390 - TIP_MARGIN - 320);
  });

  it("clamps to the margin at the left edge", () => {
    const p = computeTipPosition(rect(2, 100), { width: 320, height: 120 }, PHONE);
    expect(p.left).toBe(TIP_MARGIN);
  });

  it("never lets a too-wide panel start off-screen", () => {
    const p = computeTipPosition(rect(200, 100), { width: 600, height: 120 }, PHONE);
    expect(p.left).toBe(TIP_MARGIN);
  });

  it("flips above the trigger when it doesn't fit below and there's more room above", () => {
    const p = computeTipPosition(rect(188, 780), { width: 200, height: 160 }, PHONE);
    expect(p.placement).toBe("top");
    expect(p.top).toBe(780 - TIP_GAP - 160);
    expect(p.top).toBeGreaterThanOrEqual(TIP_MARGIN);
  });

  it("caps the height to the room on the chosen side when neither side fits", () => {
    const short = { width: 390, height: 300 };
    const p = computeTipPosition(rect(188, 100), { width: 200, height: 400 }, short);
    expect(p.placement).toBe("bottom");
    expect(p.maxHeight).toBe(300 - 114 - TIP_GAP - TIP_MARGIN);
    expect(p.top + Math.min(400, p.maxHeight)).toBeLessThanOrEqual(300 - TIP_MARGIN);
  });

  it("places the live panel inside a 390px viewport (measured through the DOM)", () => {
    const innerWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.hasAttribute("data-infotip")) return { top: 200, left: 372, bottom: 214, right: 386, width: 14, height: 14, x: 372, y: 200, toJSON() {} } as DOMRect;
      if (this.getAttribute("role") === "tooltip") return { top: 0, left: 0, bottom: 150, right: 320, width: 320, height: 150, x: 0, y: 0, toJSON() {} } as DOMRect;
      return { top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON() {} } as DOMRect;
    });
    try {
      render(<InfoTip term="saturation_yoy" />);
      act(() => trigger().focus());
      const tip = tooltip()!;
      const left = parseFloat(tip.style.left);
      expect(left).toBeGreaterThanOrEqual(TIP_MARGIN);
      expect(left + 320).toBeLessThanOrEqual(390 - TIP_MARGIN);
      expect(tip.style.visibility).toBe("visible");
      expect(tip.style.maxWidth).toBe("min(20rem, calc(100vw - 16px))");
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: innerWidth });
    }
  });
});
