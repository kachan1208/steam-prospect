import { describe, expect, it } from "vitest";

import { genreSlot, genreTintStyle, genreTintStyles } from "./heat";

/**
 * A4 — genre/tag chip colour has to be categorical inside one row.
 *
 * Measured on production /studios and /entity/* (2026-09-01): the name hash puts
 * Action and Racing on the same slot, and RPG and Simulation on another, so Ubisoft's
 * top-genres row rendered "Action · Simulation · RPG" with two identical chips.
 */

const slotOf = (style: { backgroundColor?: string }) =>
  /--series-(\d)/.exec(String(style.backgroundColor))?.[1] ?? null;

describe("genreSlot — the collisions this fix exists for are real", () => {
  it("still hashes the reported pairs onto one slot each (the defect, documented)", () => {
    expect(genreSlot("Action")).toBe(genreSlot("Racing"));
    expect(genreSlot("RPG")).toBe(genreSlot("Simulation"));
  });
});

describe("genreTintStyles — no two chips in one group share a slot", () => {
  it("separates Ubisoft's actual row: Action · Simulation · RPG", () => {
    const slots = genreTintStyles(["Action", "Simulation", "RPG"]).map(slotOf);
    expect(slots.every((s) => s !== null)).toBe(true);
    expect(new Set(slots).size).toBe(3);
  });

  it("separates the other reported pair, Action · Racing", () => {
    const slots = genreTintStyles(["Action", "Racing"]).map(slotOf);
    expect(new Set(slots).size).toBe(2);
  });

  it("keeps every group up to the 7 available slots duplicate-free", () => {
    const genres = ["Action", "Adventure", "Casual", "Indie", "Racing", "RPG", "Simulation"];
    const slots = genreTintStyles(genres).map(slotOf);
    expect(new Set(slots).size).toBe(genres.length);
  });

  it("leaves a non-colliding name on the slot its own hash chose (cross-page stability)", () => {
    expect(slotOf(genreTintStyles(["Action", "Simulation", "RPG"])[0])).toBe(String(genreSlot("Action")));
    expect(slotOf(genreTintStyles(["Strategy"])[0])).toBe(String(genreSlot("Strategy")));
  });

  it("is deterministic — the same group in gives the same colours out", () => {
    const a = genreTintStyles(["Action", "Simulation", "RPG"]).map(slotOf);
    const b = genreTintStyles(["Action", "Simulation", "RPG"]).map(slotOf);
    expect(a).toEqual(b);
  });

  it("never invents a hue: every slot stays inside the app's series ramp, slot 4 excluded", () => {
    const slots = genreTintStyles(["Action", "Simulation", "RPG", "Racing", "Casual", "Indie", "Sports"]).map(slotOf);
    for (const s of slots) expect(["1", "2", "3", "5", "6", "7", "8"]).toContain(s);
  });

  it("keeps the singular helper's old behaviour for a lone chip", () => {
    expect(genreTintStyle("Action")).toEqual(genreTintStyles(["Action"])[0]);
  });

  it("still emits both a border and a background tint at the documented alphas", () => {
    const s = genreTintStyles(["Action"])[0];
    expect(s.borderColor).toContain("55%");
    expect(s.backgroundColor).toContain("13%");
  });
});
