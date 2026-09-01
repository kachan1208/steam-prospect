/**
 * Makes recharts actually DRAW under jsdom.
 *
 * ResponsiveContainer measures its box and renders nothing at 0x0, which is every element
 * in jsdom — so chart tests here have historically been able to assert only the HTML that
 * sits beside the SVG, never the axis the user reads. Stubbing ResizeObserver to report a
 * fixed box (and pinning the container's own client size) is enough to get real ticks,
 * real strokes and real dash patterns into the DOM, which is what the chart-layer
 * regressions are actually about.
 */
export function installChartLayout(width = 900, height = 320): () => void {
  const observers = new Set<{ el: Element; cb: ResizeObserverCallback; ro: ResizeObserver }>();

  class FakeResizeObserver implements ResizeObserver {
    constructor(private cb: ResizeObserverCallback) {}
    observe(el: Element) {
      const entry = {
        target: el,
        contentRect: { width, height, top: 0, left: 0, bottom: height, right: width, x: 0, y: 0 },
      } as unknown as ResizeObserverEntry;
      observers.add({ el, cb: this.cb, ro: this });
      // Synchronous: react-testing-library's render is synchronous, and an async callback
      // would land after the assertions.
      this.cb([entry], this);
    }
    unobserve() {}
    disconnect() {
      for (const o of [...observers]) if (o.ro === this) observers.delete(o);
    }
  }

  const prevRO = globalThis.ResizeObserver;
  globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;

  const descriptors: [string, PropertyDescriptor | undefined][] = [
    ["clientWidth", Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth")],
    ["clientHeight", Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight")],
    ["offsetWidth", Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth")],
    ["offsetHeight", Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight")],
  ];
  Object.defineProperties(HTMLElement.prototype, {
    clientWidth: { configurable: true, get: () => width },
    clientHeight: { configurable: true, get: () => height },
    offsetWidth: { configurable: true, get: () => width },
    offsetHeight: { configurable: true, get: () => height },
  });

  return () => {
    globalThis.ResizeObserver = prevRO;
    for (const [name, d] of descriptors) {
      if (d) Object.defineProperty(HTMLElement.prototype, name, d);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
    }
  };
}

/** Every tick STRING an axis printed, in DOM order. */
export function axisTicks(container: HTMLElement, axis: "x" | "y", index = 0): string[] {
  const axes = container.querySelectorAll(`.recharts-${axis}Axis`);
  const el = axes[index];
  if (!el) return [];
  return Array.from(el.querySelectorAll(".recharts-cartesian-axis-tick-value")).map((t) =>
    (t.textContent ?? "").trim(),
  );
}
