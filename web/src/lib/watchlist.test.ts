import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  addGameToWatchlist,
  addNicheToWatchlist,
  clearWatchlist,
  defaultRuleFor,
  editorValueToThreshold,
  formatMetricValue,
  formatRuleLabel,
  gameWatchlistId,
  getWatchlist,
  isGameWatchlisted,
  isNicheWatchlisted,
  metricIsSigned,
  nicheWatchlistId,
  removeFromWatchlist,
  ruleFires,
  setWatchlistRule,
  subscribe,
  thresholdToEditorValue,
  toggleGameWatchlist,
  toggleNicheWatchlist,
  WATCHLIST_CAP,
  type AlertRule,
} from "./watchlist";

const STORAGE_KEY = "prospect:watchlist:v1";

beforeEach(() => {
  clearWatchlist();
  localStorage.removeItem(STORAGE_KEY);
});

describe("watchlist storage", () => {
  it("adds a niche with a default rule and reports membership", () => {
    expect(addNicheToWatchlist("tag", "Colony Sim")).toBe(true);
    expect(isNicheWatchlisted("tag", "Colony Sim")).toBe(true);
    const [entry] = getWatchlist();
    expect(entry.kind).toBe("niche");
    expect(entry.name).toBe("Colony Sim");
    expect(entry.rule).not.toBeNull();
    expect(entry.id).toBe(nicheWatchlistId("tag", "Colony Sim"));
    // addedAt is a real local timestamp, not a placeholder
    expect(Number.isNaN(Date.parse(entry.addedAt))).toBe(false);
  });

  it("adds a game with a default rule and reports membership", () => {
    expect(addGameToWatchlist(294100, "RimWorld")).toBe(true);
    expect(isGameWatchlisted(294100)).toBe(true);
    const [entry] = getWatchlist();
    expect(entry.kind).toBe("game");
    expect(entry.appid).toBe(294100);
    expect(entry.id).toBe(gameWatchlistId(294100));
  });

  it("falls back to the key/appid when no display name is given", () => {
    addNicheToWatchlist("genre", "Roguelike");
    addGameToWatchlist(42);
    const [niche, game] = getWatchlist();
    expect(niche.name).toBe("Roguelike");
    expect(game.name).toBe("App 42");
  });

  it("dedupes niches by dimension+key (same key, different dimension is NOT a dupe)", () => {
    expect(addNicheToWatchlist("tag", "Action")).toBe(true);
    expect(addNicheToWatchlist("tag", "Action")).toBe(false);
    expect(addNicheToWatchlist("genre", "Action")).toBe(true);
    expect(getWatchlist()).toHaveLength(2);
  });

  it("dedupes games by appid", () => {
    addGameToWatchlist(1, "A");
    expect(addGameToWatchlist(1, "A again")).toBe(false);
    expect(getWatchlist()).toHaveLength(1);
  });

  it("caps the list at WATCHLIST_CAP", () => {
    for (let i = 1; i <= WATCHLIST_CAP; i++) expect(addGameToWatchlist(i, `G${i}`)).toBe(true);
    expect(addGameToWatchlist(999999, "Overflow")).toBe(false);
    expect(getWatchlist()).toHaveLength(WATCHLIST_CAP);
  });

  it("removes and clears", () => {
    addNicheToWatchlist("tag", "A");
    addGameToWatchlist(2, "B");
    const id = nicheWatchlistId("tag", "A");
    removeFromWatchlist(id);
    expect(getWatchlist().map((e) => e.id)).toEqual([gameWatchlistId(2)]);
    clearWatchlist();
    expect(getWatchlist()).toEqual([]);
  });

  it("toggles niches and games add-then-remove", () => {
    expect(toggleNicheWatchlist("tag", "Deckbuilder")).toBe("added");
    expect(toggleNicheWatchlist("tag", "Deckbuilder")).toBe("removed");
    expect(isNicheWatchlisted("tag", "Deckbuilder")).toBe(false);

    expect(toggleGameWatchlist(5, "E")).toBe("added");
    expect(toggleGameWatchlist(5, "E")).toBe("removed");
    expect(isGameWatchlisted(5)).toBe(false);
  });

  it("persists to the versioned localStorage key", () => {
    addGameToWatchlist(42, "Answer");
    const raw = localStorage.getItem(STORAGE_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].appid).toBe(42);
  });

  it("drops malformed entries on load instead of crashing", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        { id: "game:1", kind: "game", appid: 1, name: "Ok", addedAt: "2026-01-01T00:00:00.000Z", rule: null },
        { id: "game:2", kind: "game", name: "Missing appid" }, // invalid: no appid
        { id: "niche:x", kind: "niche", dimension: "tag", name: "Missing key" }, // invalid: no key
        { kind: "game", appid: 3 }, // invalid: no id
        "not even an object",
      ]),
    );
    // Force a reload from storage via the cross-tab path rather than relying on module init.
    window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY }));
    expect(getWatchlist()).toEqual([
      { id: "game:1", kind: "game", appid: 1, name: "Ok", addedAt: "2026-01-01T00:00:00.000Z", rule: null },
    ]);
  });

  it("ignores corrupt JSON and starts empty rather than throwing", () => {
    localStorage.setItem(STORAGE_KEY, "{not json");
    expect(() => window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY }))).not.toThrow();
    expect(getWatchlist()).toEqual([]);
  });

  it("notifies subscribers on every mutation and supports unsubscribe", () => {
    const spy = vi.fn();
    const unsub = subscribe(spy);
    addGameToWatchlist(1, "A");
    removeFromWatchlist(gameWatchlistId(1));
    clearWatchlist();
    expect(spy).toHaveBeenCalledTimes(3);
    unsub();
    addGameToWatchlist(2, "B");
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it("keeps a stable snapshot reference between mutations (useSyncExternalStore contract)", () => {
    addGameToWatchlist(1, "A");
    const a = getWatchlist();
    const b = getWatchlist();
    expect(a).toBe(b);
    addGameToWatchlist(2, "B");
    expect(getWatchlist()).not.toBe(a);
  });

  it("setWatchlistRule replaces or clears a rule, no-ops on unknown id", () => {
    addGameToWatchlist(1, "A");
    const id = gameWatchlistId(1);
    const rule: AlertRule = { metric: "price_initial", comparator: "lt", threshold: 9.99 };
    setWatchlistRule(id, rule);
    expect(getWatchlist()[0].rule).toEqual(rule);
    setWatchlistRule(id, null);
    expect(getWatchlist()[0].rule).toBeNull();
    setWatchlistRule("game:does-not-exist", rule);
    expect(getWatchlist()).toHaveLength(1); // unchanged, no crash
  });
});

describe("defaultRuleFor", () => {
  it("gives niches a players-7d-up default and games a price-drop default", () => {
    expect(defaultRuleFor("niche")).toEqual({ metric: "players_trend_7d_pct", comparator: "gt", threshold: 20 });
    expect(defaultRuleFor("game")).toEqual({ metric: "price_initial", comparator: "lt", threshold: 14.99 });
  });
});

describe("formatRuleLabel", () => {
  it("formats every metric/comparator combination the mockup's rule column illustrates", () => {
    // players_trend_7d_pct's threshold is a plain percent number (NOT a fraction) — matches
    // how the rest of the app already reads this exact API field (NicheDetail's `< -10`
    // decline check, GameProfile's `.toFixed(1)}%` with no ×100).
    expect(formatRuleLabel({ metric: "players_trend_7d_pct", comparator: "gt", threshold: 20 })).toBe(
      "players 7d ▲ > +20%",
    );
    expect(formatRuleLabel({ metric: "players_trend_7d_pct", comparator: "lt", threshold: -10 })).toBe(
      "players 7d ▼ > −10%",
    );
    expect(formatRuleLabel({ metric: "saturation_yoy", comparator: "gt", threshold: 0 })).toBe(
      "saturation YoY turns positive",
    );
    expect(formatRuleLabel({ metric: "saturation_yoy", comparator: "lt", threshold: 0 })).toBe(
      "saturation YoY turns negative",
    );
    expect(formatRuleLabel({ metric: "opportunity_v2", comparator: "gt", threshold: 85 })).toBe("opp v2 crosses 85");
    expect(formatRuleLabel({ metric: "opportunity_v2", comparator: "lt", threshold: 40 })).toBe(
      "opp v2 drops below 40",
    );
    expect(formatRuleLabel({ metric: "price_initial", comparator: "lt", threshold: 14.99 })).toBe(
      "price drops below $14.99",
    );
    expect(formatRuleLabel({ metric: "price_initial", comparator: "gt", threshold: 29.99 })).toBe(
      "price rises above $29.99",
    );
  });
});

describe("ruleFires", () => {
  const rule: AlertRule = { metric: "players_trend_7d_pct", comparator: "gt", threshold: 20 };

  it("returns true/false when a live value is available", () => {
    expect(ruleFires(rule, 24)).toBe(true);
    expect(ruleFires(rule, 10)).toBe(false);
    expect(ruleFires(rule, 20)).toBe(false); // strict >, boundary does not fire
  });

  it("returns null (unknown, never a false negative) when there's no live data yet", () => {
    expect(ruleFires(rule, null)).toBeNull();
    expect(ruleFires(rule, undefined)).toBeNull();
    expect(ruleFires(rule, NaN)).toBeNull();
  });

  it("respects the lt comparator", () => {
    const dropRule: AlertRule = { metric: "price_initial", comparator: "lt", threshold: 14.99 };
    expect(ruleFires(dropRule, 9.99)).toBe(true);
    expect(ruleFires(dropRule, 19.99)).toBe(false);
  });
});

describe("formatMetricValue / metricIsSigned", () => {
  it("renders each metric in its own native unit", () => {
    expect(formatMetricValue("players_trend_7d_pct", 24)).toBe("+24.0%");
    expect(formatMetricValue("players_trend_7d_pct", -16)).toBe("−16.0%");
    expect(formatMetricValue("saturation_yoy", 0.24)).toBe("+24.0%");
    expect(formatMetricValue("saturation_yoy", -0.16)).toBe("−16.0%");
    expect(formatMetricValue("opportunity_v2", 87.42)).toBe("87.4");
    expect(formatMetricValue("price_initial", 14.9)).toBe("$14.90");
  });

  it("only trend/YoY metrics are glyph-signed — a score or a price is not inherently up/down", () => {
    expect(metricIsSigned("players_trend_7d_pct")).toBe(true);
    expect(metricIsSigned("saturation_yoy")).toBe(true);
    expect(metricIsSigned("opportunity_v2")).toBe(false);
    expect(metricIsSigned("price_initial")).toBe(false);
  });
});

describe("editor <-> threshold unit conversion", () => {
  it("passes players_trend_7d_pct through unchanged (already a percent number)", () => {
    const rule: AlertRule = { metric: "players_trend_7d_pct", comparator: "gt", threshold: 20 };
    expect(thresholdToEditorValue(rule)).toBe(20);
    expect(editorValueToThreshold("players_trend_7d_pct", 20)).toBe(20);
  });

  it("round-trips saturation_yoy through its fraction<->percent scaling", () => {
    const rule: AlertRule = { metric: "saturation_yoy", comparator: "gt", threshold: 0.24 };
    expect(thresholdToEditorValue(rule)).toBe(24);
    expect(editorValueToThreshold("saturation_yoy", 24)).toBeCloseTo(0.24);
  });
});
