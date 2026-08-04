/**
 * Split mart_game's comma-joined `developers` / `publishers` strings into entity names.
 *
 * Steam joins multiple credits with a bare "," ("Mike Klubnika,GDeavid"), but entity names
 * themselves legally contain ", Inc." / ", Ltd." style corporate suffixes ("FromSoftware,
 * Inc.", "CAPCOM Co., Ltd.") — so a naive split(",") shears one company into two. Rule:
 * split on ",", then re-merge any token that is *just* a corporate suffix (optionally
 * trailed by a parenthetical region note, e.g. "Inc. (Japan)") back into the previous
 * token, restoring the ", " the split consumed.
 *
 * This mirrors the ETL's entity-normalization suffix-remerge tunable (the list of suffix
 * tokens the entity marts use when building mart_entity from the same strings) — keep the
 * two lists in sync, or links from game pages will point at names mart_entity doesn't have.
 */
const SUFFIX_TOKEN =
  /^(inc|incorporated|llc|ltd|limited|co|corp|corporation|gmbh|s\.?r\.?o|plc|llp|lp|kk|kg|ag|ab|bv|oy|sa|srl|pte|pty|jr|sr)\.?(\s*\(.*\))?$/i;

export function splitEntities(joined: string | null | undefined): string[] {
  if (!joined) return [];
  const out: string[] = [];
  for (const raw of joined.split(",")) {
    const token = raw.trim();
    if (!token) continue;
    if (out.length > 0 && SUFFIX_TOKEN.test(token)) {
      out[out.length - 1] = `${out[out.length - 1]}, ${token}`;
    } else {
      out.push(token);
    }
  }
  return out;
}
