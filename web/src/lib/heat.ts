import type { CSSProperties } from "react";

/**
 * Heat tint for magnitude cells in dense tables — the number stays normal ink, the cell
 * background carries the percentile, so a column reads as a gradient (same job as the
 * seasonality heatmap, but with text on top: tint alpha is capped at 42%, which keeps
 * PRIMARY ink comfortably AA in both themes — 9.2:1 light / 8.5:1 dark at full tint.
 * Secondary/muted ink over a full tint dips under AA, so heat cells must use primary ink.
 * color-mix against transparent keeps it theme-aware for free).
 *
 * Log-scaled: revenue/reviews/owners are log-distributed, so a linear ramp would leave
 * every non-outlier row at ~0 and one megahit fully saturated.
 */
export function heatStyle(
  value: number | null | undefined,
  min: number,
  max: number,
  scale: "log" | "linear" = "log",
): CSSProperties | undefined {
  if (value == null || !Number.isFinite(value) || value <= 0) return undefined;
  let t: number;
  if (scale === "linear") {
    // For bounded ratios (hit rate, shares) — a log ramp would crush the top end.
    if (max <= min) return undefined;
    t = (value - min) / (max - min);
  } else {
    const lo = Math.log10(Math.max(1, min));
    const hi = Math.log10(Math.max(1, max));
    if (hi <= lo) return undefined;
    t = (Math.log10(value) - lo) / (hi - lo);
  }
  const pct = Math.round(Math.max(0, Math.min(1, t)) * 42);
  if (pct < 4) return undefined; // below the ramp floor a tint just reads as dirt
  return { backgroundColor: `color-mix(in srgb, var(--series-1) ${pct}%, transparent)` };
}

/**
 * Stable categorical tint for genre/tag chips — hashes the name into one of the app's
 * series slots and returns border+background tints (low alpha, neutral text on top), so
 * the same genre wears the same hue on every page.
 * Slot 4 (#008300) is excluded: it is visually near status-good, and a green-hashed chip
 * sitting beside an "Active" badge or verdict text would read as a status signal.
 *
 * WITHIN ONE ROW THE SLOTS ARE MADE UNIQUE (2026-09-01). The hash alone shipped literal
 * duplicates in a single chip group — measured on production /studios and /entity/*:
 *
 *     Action  = Racing     -> slot 7, #d55181
 *     RPG     = Simulation -> slot 8, #d95926
 *
 * so Ubisoft's row rendered "Action · Simulation · RPG" with two identical orange chips.
 * "Same hue does not imply same genre" was the standing defence, and it holds ACROSS
 * pages, where you never see the two chips together. It does not hold inside one row,
 * which is exactly where a reader reads colour as a discriminator — categorical colour
 * that isn't categorical.
 *
 * genreTintStyles() therefore assigns per GROUP: each name keeps its hashed slot when
 * that slot is still free, and otherwise walks the ring to the next free one.
 * Deterministic (same input order in, same colours out). Cross-page stability is unchanged
 * for every name that doesn't collide; a name that does gives up its global hue to keep
 * the row honest, which is the right trade — the chip always prints its name, so a shifted
 * hue costs recognition while a duplicated hue costs correctness.
 *
 * Groups of 8+ (Compare's top-tags cells) still exhaust the 7 slots by pigeonhole; those
 * fall back to the hashed slot rather than inventing a hue. The rows this defect was
 * reported on print 3, and every group up to 7 is now duplicate-free.
 */
const GENRE_SLOTS = [1, 2, 3, 5, 6, 7, 8] as const;

/** The hashed (preferred) slot for a name, before any in-row collision resolution. */
export function genreSlot(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return GENRE_SLOTS[h % GENRE_SLOTS.length];
}

function tintFor(slot: number): CSSProperties {
  return {
    borderColor: `color-mix(in srgb, var(--series-${slot}) 55%, transparent)`,
    backgroundColor: `color-mix(in srgb, var(--series-${slot}) 13%, transparent)`,
  };
}

/** Tints for one chip GROUP, in input order, with no slot used twice. */
export function genreTintStyles(names: readonly string[]): CSSProperties[] {
  const taken = new Set<number>();
  return names.map((name) => {
    const preferred = genreSlot(name);
    let slot = preferred;
    if (taken.has(slot)) {
      const start = GENRE_SLOTS.indexOf(preferred as (typeof GENRE_SLOTS)[number]);
      for (let step = 1; step <= GENRE_SLOTS.length; step++) {
        const candidate = GENRE_SLOTS[(start + step) % GENRE_SLOTS.length];
        if (!taken.has(candidate)) {
          slot = candidate;
          break;
        }
      }
    }
    taken.add(slot);
    return tintFor(slot);
  });
}

/** Single-chip convenience — identical to the old behaviour (nothing to collide with). */
export function genreTintStyle(name: string): CSSProperties {
  return tintFor(genreSlot(name));
}

/** Min/max over the non-null positive values of one column — feed to heatStyle per row. */
export function heatDomain<T>(rows: T[], pick: (row: T) => number | null | undefined): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (const r of rows) {
    const v = pick(r);
    if (v != null && Number.isFinite(v) && v > 0) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  return min <= max ? [min, max] : [0, 0];
}

/**
 * Verdict color for Steam positive-review ratio (0..1) — the one magnitude with a
 * universally understood good/bad reading. This IS a trend verdict in the design
 * handoff's sense (README, Interactions: "Up = accent-300, down/flat = paper 55%. Never
 * red/green — the palette is mono steel"), so it no longer reaches for the red/green
 * text-verdict-good/text-verdict-serious classes (those stay reserved for actual error
 * states — see e.g. GameTrendsChart's "failed to load" message). A standout ratio (>=80%)
 * reads accent-300; a weak one (<70%) recedes to muted ink, exactly like a down/flat
 * trend arrow; the middle band stays neutral ink, unstyled.
 *
 * `text-[color:var(--accent-300)]` is a Tailwind arbitrary-value utility (no config
 * change needed) rather than `text-brand`, because --brand tracks the user's selected
 * accent preset (theme.tsx) while the handoff's mono language is pinned to the literal
 * steel accent-300 — the two only coincide when "Industry" (the default) is selected.
 */
export function positiveRatioClass(ratio: number | null | undefined): string {
  if (ratio == null) return "";
  if (ratio >= 0.8) return "text-[color:var(--accent-300)]";
  if (ratio < 0.7) return "text-ink-muted";
  return "";
}
