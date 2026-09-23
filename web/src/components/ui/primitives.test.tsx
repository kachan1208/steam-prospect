import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import { KpiCell } from "./KpiCell";
import { StatTile } from "./StatTile";
import { BulletMeter, PercentileMeter } from "./Meter";
import { HeaderLabel } from "./HeaderLabel";
import { GLOSSARY } from "../../lib/glossary";

/**
 * The shared metric primitives adopt the ⓘ by glossary key — and every existing call site
 * (label + value, StatTile's old `help` string) keeps rendering exactly what it did.
 */

afterEach(cleanup);

const about = (label: string) => screen.getByRole("button", { name: `About ${label}` });
const openTip = (label: string) => {
  act(() => about(label).focus());
  return screen.getByRole("tooltip");
};

describe("KpiCell", () => {
  it("renders exactly as before when given no explanation — no ⓘ", () => {
    render(<KpiCell label="Games" value="223" footnote="scored games" />);
    expect(screen.getByText("Games")).toBeTruthy();
    expect(screen.getByText("223")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("takes its label and explanation from a glossary term, with the row's worked numbers", () => {
    render(<KpiCell term="saturation_yoy" value="−7.4%" worked="(176 − 190) ÷ 190 = −7.4%" />);
    expect(screen.getByText(GLOSSARY.saturation_yoy.label)).toBeTruthy();
    const tip = openTip(GLOSSARY.saturation_yoy.label);
    expect(tip.textContent).toContain(GLOSSARY.saturation_yoy.formula);
    expect(tip.textContent).toContain("(176 − 190) ÷ 190 = −7.4%");
  });

  it("keeps an explicit label but explains it with the glossary's canonical name", () => {
    render(<KpiCell label="P90 revenue" term="p90_rev" value="$1.2M" />);
    expect(screen.getByText("P90 revenue")).toBeTruthy();
    const tip = openTip(GLOSSARY.p90_rev.label);
    expect(tip.textContent).toContain("Top-10% revenue");
  });

  it("marks a sentinel visibly beside the label, and explains it in the ⓘ", () => {
    render(<KpiCell term="supply_brake" value="×1.00" sentinel={{ tag: "unknown → ×1.00", detail: "no supply read — never a penalty" }} />);
    const tag = document.querySelector("[data-sentinel]")!;
    expect(tag.textContent).toBe("unknown → ×1.00");
    expect(openTip(GLOSSARY.supply_brake.label).textContent).toContain("no supply read — never a penalty");
  });
});

describe("StatTile", () => {
  it("turns the old hover-only `help` into an accessible ⓘ, and drops the tile's title", () => {
    const { container } = render(<StatTile label="Median revenue" value="$12K" help="Half the games earn less." />);
    expect((container.firstElementChild as HTMLElement).hasAttribute("title")).toBe(false);
    expect(openTip("Median revenue").textContent).toContain("Half the games earn less.");
  });

  it("renders no ⓘ when there is nothing to explain", () => {
    render(<StatTile label="Games" value="12" />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("an interactive tile is a real toggle button, and its ⓘ is a sibling — never inside it", () => {
    const onClick = vi.fn();
    render(<StatTile label="Owners" value="1.2M" sub="SteamSpy" term="owners" onClick={onClick} active />);
    const toggle = screen.getByRole("button", { name: "Owners" });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    const tipBtn = about(GLOSSARY.owners.label);
    expect(toggle.contains(tipBtn)).toBe(false);
    fireEvent.click(toggle);
    expect(onClick).toHaveBeenCalledTimes(1);
    // Pressing the ⓘ — by click or by keyboard — never toggles the tile.
    fireEvent.click(tipBtn);
    fireEvent.keyDown(tipBtn, { key: "Enter" });
    expect(onClick).toHaveBeenCalledTimes(1);
    // The value and footnote describe the toggle for screen readers.
    const described = (toggle.getAttribute("aria-describedby") ?? "").split(" ").map((id) => document.getElementById(id)?.textContent);
    expect(described).toEqual(["1.2M", "SteamSpy"]);
  });
});

describe("BulletMeter / PercentileMeter", () => {
  it("draws a DASHED empty rail for a missing value — an empty solid rail reads as 0%", () => {
    render(<BulletMeter label="Hit rate" value={null} color="red" valueLabel="—" />);
    const bar = screen.getByRole("img");
    expect(bar.hasAttribute("data-empty")).toBe(true);
    expect(bar.getAttribute("aria-label")).toBe("Hit rate: no data");
  });

  it("puts the benchmark tick's label in the bar's accessible description", () => {
    render(<BulletMeter label="Revenue" value={0.4} benchmark={0.5} benchmarkLabel="genre median" color="red" valueLabel="P40" />);
    expect(screen.getByRole("img").getAttribute("aria-label")).toBe("Revenue: P40; tick: genre median");
  });

  it("adopts the ⓘ by glossary term", () => {
    render(<BulletMeter term="hit_rate_200k" value={0.12} color="red" valueLabel="12.0%" worked="27 of 223 games clear $200K" />);
    expect(screen.getByText(GLOSSARY.hit_rate_200k.label)).toBeTruthy();
    expect(openTip(GLOSSARY.hit_rate_200k.label).textContent).toContain("27 of 223 games clear $200K");
  });

  it("PercentileMeter floors the rank and never prints P100 for a 99.6", () => {
    render(<PercentileMeter label="Revenue" percentile={99.6} peers="Action games" color="red" />);
    expect(screen.getByText("top 1%")).toBeTruthy();
    const tip = openTip("Revenue — rank vs Action games");
    expect(tip.textContent).toContain("beats 99.6% of Action games → top 1%");
    expect(tip.textContent).toContain("the median of Action games (P50)");
  });

  it("PercentileMeter floors a mid rank", () => {
    render(<PercentileMeter label="Owners" percentile={73.9} color="red" />);
    expect(screen.getByText("P73")).toBeTruthy();
  });

  it("PercentileMeter flags a missing rank instead of drawing an empty bar", () => {
    render(<PercentileMeter label="Revenue" percentile={null} color="red" />);
    expect(document.querySelector("[data-sentinel]")!.textContent).toBe("not ranked");
    expect(screen.getByRole("img").hasAttribute("data-empty")).toBe(true);
  });

  it("draws no median tick on an empty rail — a lone tick over nothing reads as P50", () => {
    render(<PercentileMeter label="Revenue" percentile={null} color="red" />);
    expect(screen.getByRole("img").querySelector("div")).toBeNull();
    cleanup();
    render(<PercentileMeter label="Revenue" percentile={73.9} color="red" />);
    // With a value the fill and the tick are both there.
    expect(screen.getByRole("img").querySelectorAll("div").length).toBe(2);
  });
});

describe("HeaderLabel", () => {
  it("sorts from the label, explains from the ⓘ — two sibling buttons", () => {
    const onSort = vi.fn();
    render(<HeaderLabel term="p90_rev" sort={{ col: "p90_rev", active: true, order: "desc", onSort }} />);
    const sortBtn = screen.getByRole("button", { name: GLOSSARY.p90_rev.short });
    const tipBtn = about(GLOSSARY.p90_rev.label);
    expect(sortBtn.contains(tipBtn)).toBe(false);
    expect(within(sortBtn).getByText("↓")).toBeTruthy();
    fireEvent.click(tipBtn);
    expect(onSort).not.toHaveBeenCalled();
    fireEvent.click(sortBtn);
    expect(onSort).toHaveBeenCalledWith("p90_rev");
  });

  it("renders a plain, non-sortable header with an explicit label and help", () => {
    render(<HeaderLabel label="Verdict" help="The Radar's call for this row." />);
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(openTip("Verdict").textContent).toContain("The Radar's call for this row.");
  });
});
