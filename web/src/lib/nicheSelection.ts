/**
 * THE multi-niche selection URL contract — one module writes AND parses it, so the finder
 * (which builds these links) and /niches/combined (which reads them) cannot drift apart.
 *
 * A selection rides the URL as repeated `niches=<dimension>:<key>` params (plus `mode`,
 * `win`, `min_reviews`), so every combination is shareable and bookmarkable — the same
 * reasoning as /compare?ids=. Keys are hostile to naive string joins (spaces, ampersands,
 * apostrophes: "Point & Click", "Beat 'em up"), so every hop through a URL goes through
 * URLSearchParams, never through hand-rolled joins.
 *
 * A LEAF module (2026-08-29) — types only, no components, no charts — because it used to
 * live on pages/NicheCombined: NicheFinder's import of six pure helpers from there made
 * the /niches chunk statically depend on NicheCombined → NicheDetail → vendor-recharts,
 * 109KB gz of charting for a page that draws none. Separate from lib/nichePath.ts so the
 * eager entry chunk, which needs that file's route pattern, doesn't carry these too.
 */
import type { Dimension, NicheCombineMode, Window } from "./api";

/** Six is the point where the intersection is almost always empty and the chips stop
 * fitting on one row — the same cap, for the same reason, as the games compare list. */
export const NICHE_COMBINE_CAP = 6;

export interface NicheSelection {
  dimension: Dimension;
  key: string;
}

const DIMENSIONS: Dimension[] = ["tag", "genre"];

/** "tag:Point & Click" — dimension, a colon, then the key VERBATIM (URL encoding is the
 * URLSearchParams layer's job, not this one's). */
export function formatNicheRef(sel: NicheSelection): string {
  return `${sel.dimension}:${sel.key}`;
}

/** Inverse of formatNicheRef. Splits on the FIRST colon so a key containing one survives;
 * returns null for an unknown dimension or an empty key rather than inventing a niche. */
export function parseNicheRef(raw: string): NicheSelection | null {
  const i = raw.indexOf(":");
  if (i <= 0) return null;
  const dimension = raw.slice(0, i);
  const key = raw.slice(i + 1);
  if (!DIMENSIONS.includes(dimension as Dimension) || key === "") return null;
  return { dimension: dimension as Dimension, key };
}

/** Every valid `niches=` param, deduped, in URL order, capped at NICHE_COMBINE_CAP. */
export function parseNicheSelection(params: URLSearchParams): NicheSelection[] {
  const out: NicheSelection[] = [];
  const seen = new Set<string>();
  for (const raw of params.getAll("niches")) {
    const sel = parseNicheRef(raw);
    if (!sel) continue;
    const ref = formatNicheRef(sel);
    if (seen.has(ref)) continue;
    seen.add(ref);
    out.push(sel);
    if (out.length >= NICHE_COMBINE_CAP) break;
  }
  return out;
}

export function parseCombineMode(raw: string | null): NicheCombineMode {
  return raw === "union" ? "union" : "intersect";
}

export interface NicheCut {
  win: Window;
  min_reviews: number;
}

/** /niches/combined?niches=tag:Roguelike&niches=tag:Deckbuilding&mode=intersect — the
 * link the finder's "Analyse combined" button navigates to. */
export function nicheCombinedPath(selection: NicheSelection[], mode: NicheCombineMode, cut?: NicheCut): string {
  const sp = new URLSearchParams();
  for (const s of selection) sp.append("niches", formatNicheRef(s));
  sp.set("mode", mode);
  if (cut) {
    sp.set("win", cut.win);
    sp.set("min_reviews", String(cut.min_reviews));
  }
  return `/niches/combined?${sp.toString()}`;
}

/** Back-link to the finder with the selection intact, so the checkboxes stay ticked. */
export function nicheFinderPath(selection: NicheSelection[]): string {
  if (selection.length === 0) return "/niches";
  const sp = new URLSearchParams();
  for (const s of selection) sp.append("niches", formatNicheRef(s));
  return `/niches?${sp.toString()}`;
}
