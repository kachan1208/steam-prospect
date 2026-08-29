/**
 * THE niche URL contract: the /niches/:dimension/:key route pattern, the link builders,
 * and the `?niches=` multi-select serialisation the finder writes and /niches/combined
 * reads. A leaf module — types only from lib/api, no components, no charts.
 *
 * Extracted from pages/NicheDetail.tsx (2026-08-28, route code-splitting): App.tsx's
 * route table and the eagerly-loaded RadarBoard both need to LINK to a niche, and when
 * these lived on the page module that import statically dragged the whole 80K
 * NicheDetail page (and, through its chart imports, all of recharts) into the entry
 * chunk — defeating React.lazy. Pages may import from here freely; NOTHING may import a
 * helper FROM a pages/* module (see lib/nicheSelection.ts, which exists because they did).
 *
 * These two are what the EAGER modules (App's route table, RadarBoard) need, so they — and
 * only they — ride in the entry chunk. The multi-select `?niches=` contract, which no eager
 * module touches, lives one door down in lib/nicheSelection.ts and stays out of the entry.
 */

/** The one place the route pattern is spelled; App.tsx and the round-trip test both use it. */
export const NICHE_ROUTE_PATH = "/niches/:dimension/:key";

/**
 * Canonical link to a niche page. Keys carry spaces AND slashes ("Action Roguelike",
 * "Massively Multiplayer/RPG"), so the key segment is always percent-encoded — React Router
 * decodes `:key` back (it un-escapes each segment and then restores %2F to "/"), so the
 * value handed to useParams is byte-for-byte the key we linked. See NicheDetail.test.tsx.
 */
export function nicheDetailPath(
  dimension: string,
  key: string,
  search?: Record<string, string | number | undefined | null>,
): string {
  const base = `/niches/${encodeURIComponent(dimension)}/${encodeURIComponent(key)}`;
  if (!search) return base;
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(search)) {
    if (v === undefined || v === null || v === "") continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `${base}?${s}` : base;
}

