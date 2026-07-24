import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { Badge } from "../components/ui/Badge";
import { Card } from "../components/ui/Card";
import { API_BASE, ApiError, useGameSearch } from "../lib/api";
import { fmtInt } from "../lib/format";

// ---- local fetch helper -----------------------------------------------------------------
// Mirrors the private `request` in lib/api.ts (which isn't exported) using the exported
// API_BASE + ApiError, so this page fetches identically without editing the shared client.
async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    let detail: unknown = res.statusText;
    try {
      const body = (await res.clone().json()) as { detail?: unknown };
      detail = body?.detail ?? detail;
    } catch {
      // non-JSON error body; fall back to statusText
    }
    throw new ApiError(res.status, typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// ---- server-side types (mirror api/app/routers/inputs.py — events + the read-only
// wishlist benchmark are the only pieces still server-side; goals/milestones are local) ----
type EventKind = "trailer" | "festival" | "press" | "update" | "other";

interface MarketingEvent {
  id: number;
  appid: number;
  event_date: string;
  kind: string;
  note: string | null;
  created_at: string;
}

interface WishlistBenchmark {
  appid: number;
  primary_genre: string | null;
  suggested_target: number;
  basis: string[];
}

const KIND_OPTIONS: { value: EventKind; label: string }[] = [
  { value: "trailer", label: "Trailer" },
  { value: "festival", label: "Festival" },
  { value: "press", label: "Press" },
  { value: "update", label: "Update" },
  { value: "other", label: "Other" },
];

const KIND_LABEL: Record<string, string> = Object.fromEntries(KIND_OPTIONS.map((k) => [k.value, k.label]));

// Fixed categorical hues from the app's validated series ramp (see lib/palette.ts) — dot
// only, never on text (Badge keeps the label neutral-ink).
const KIND_COLOR: Record<string, string> = {
  trailer: "var(--series-1)",
  festival: "var(--series-3)",
  press: "var(--series-6)",
  update: "var(--series-2)",
  other: "var(--text-muted)",
};

// ---- browser-local goals/milestones (no server writes) -----------------------------------
// The control-plane WishlistGoal/WishlistMilestone tables were removed in the minimal-tool
// trim — everything the dev types about wishlist targets/history now lives ONLY here, in
// localStorage. Marketing events (above) stay server-side: the trends chart's event overlay
// reads them back from the API, not the browser.
const STORAGE_KEY = "prospect.devlog.v1";
const MAX_RECENT_GAMES = 8;

interface StoredGoal {
  target: number;
  note: string | null;
  updated_at: string;
}

interface StoredMilestone {
  id: string;
  on_date: string;
  wishlists: number | null;
  followers: number | null;
  source: "manual" | "csv";
  created_at: string;
}

interface StoredGameMeta {
  appid: number;
  name: string | null;
  header_image: string | null;
  primary_genre: string | null;
}

interface DevLogState {
  recentGames: StoredGameMeta[]; // most-recently-used first, capped at MAX_RECENT_GAMES
  goals: Record<string, StoredGoal>; // keyed by String(appid)
  milestones: Record<string, StoredMilestone[]>; // keyed by String(appid), oldest -> newest
}

const EMPTY_STATE: DevLogState = { recentGames: [], goals: {}, milestones: {} };

function loadState(): DevLogState {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY_STATE;
    const parsed = JSON.parse(raw) as Partial<DevLogState>;
    return {
      recentGames: Array.isArray(parsed.recentGames) ? parsed.recentGames : [],
      goals: parsed.goals && typeof parsed.goals === "object" ? parsed.goals : {},
      milestones: parsed.milestones && typeof parsed.milestones === "object" ? parsed.milestones : {},
    };
  } catch {
    return EMPTY_STATE; // private-browsing / storage-disabled / corrupt JSON — start fresh
  }
}

function saveState(state: DevLogState): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage disabled or quota exceeded — non-fatal, edits just won't persist this session.
  }
}

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Owns the whole localStorage blob as React state (one instance for the page) so every
 * panel re-renders on edits, persisting to storage on every change. */
function useDevLogStore() {
  const [state, setState] = useState<DevLogState>(() => loadState());

  function update(fn: (prev: DevLogState) => DevLogState) {
    setState((prev) => {
      const next = fn(prev);
      saveState(next);
      return next;
    });
  }

  function touchGame(meta: StoredGameMeta) {
    update((prev) => ({
      ...prev,
      recentGames: [meta, ...prev.recentGames.filter((g) => g.appid !== meta.appid)].slice(0, MAX_RECENT_GAMES),
    }));
  }

  function setGoal(appid: number, target: number, note?: string) {
    update((prev) => ({
      ...prev,
      goals: {
        ...prev.goals,
        [appid]: { target, note: note?.trim() || null, updated_at: new Date().toISOString() },
      },
    }));
  }

  function clearGoal(appid: number) {
    update((prev) => {
      const goals = { ...prev.goals };
      delete goals[String(appid)];
      return { ...prev, goals };
    });
  }

  function addMilestones(appid: number, rows: Omit<StoredMilestone, "id" | "created_at">[]) {
    if (rows.length === 0) return;
    update((prev) => {
      const key = String(appid);
      const createdAt = new Date().toISOString();
      const added = rows.map((m) => ({ ...m, id: newId(), created_at: createdAt }));
      const next = [...(prev.milestones[key] ?? []), ...added].sort((a, b) => a.on_date.localeCompare(b.on_date));
      return { ...prev, milestones: { ...prev.milestones, [key]: next } };
    });
  }

  function deleteMilestone(appid: number, id: string) {
    update((prev) => {
      const key = String(appid);
      return {
        ...prev,
        milestones: { ...prev.milestones, [key]: (prev.milestones[key] ?? []).filter((m) => m.id !== id) },
      };
    });
  }

  return { state, touchGame, setGoal, clearGoal, addMilestones, deleteMilestone };
}

// ---- client-side CSV parsing (ported from the removed backend import_wishlist) -----------
interface ParsedImport {
  rows: Omit<StoredMilestone, "id" | "created_at">[];
  skipped: number;
  errors: string[];
}

function parseIsoDate(s: string): string | null {
  const t = s.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return null;
  const d = new Date(`${t}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : t;
}

function parseCount(s: string): number | null {
  const t = s.trim().replace(/,/g, "").replace(/_/g, "");
  if (t === "") return null;
  const n = Math.floor(Number(t));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Bulk-parse pasted CSV: 'YYYY-MM-DD,wishlists[,followers]'. Blank lines and an optional
 * header row (a first line whose first field isn't a date) are ignored; malformed rows are
 * skipped and counted (with a reason) rather than failing the whole import. */
function parseWishlistCsv(csv: string): ParsedImport {
  const rows: ParsedImport["rows"] = [];
  let skipped = 0;
  const errors: string[] = [];
  let firstContent = true;

  csv.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const parts = line.split(",").map((p) => p.trim());

    if (firstContent) {
      firstContent = false;
      if (parseIsoDate(parts[0]) === null) return; // treat a non-date first line as a header
    }

    if (parts.length < 2) {
      skipped += 1;
      errors.push(`line ${i + 1}: expected at least date,wishlists`);
      return;
    }
    const onDate = parseIsoDate(parts[0]);
    if (onDate === null) {
      skipped += 1;
      errors.push(`line ${i + 1}: invalid date '${parts[0]}'`);
      return;
    }
    const wishlists = parseCount(parts[1]);
    if (wishlists === null) {
      skipped += 1;
      errors.push(`line ${i + 1}: invalid wishlists '${parts[1]}'`);
      return;
    }
    const followers = parts.length >= 3 ? parseCount(parts[2]) : null;
    rows.push({ on_date: onDate, wishlists, followers, source: "csv" });
  });

  return { rows, skipped, errors: errors.slice(0, 20) };
}

// ---- server hooks (events + the read-only benchmark) -------------------------------------
function useEvents(appid: number | null) {
  return useQuery({
    queryKey: ["inputs", "events", appid],
    queryFn: () => req<MarketingEvent[]>(`/inputs/events?appid=${appid}`),
    enabled: appid !== null,
  });
}

function useAddEvent(appid: number | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { appid: number; event_date: string; kind: EventKind; note?: string }) =>
      req<MarketingEvent>("/inputs/events", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["inputs", "events", appid] }),
  });
}

function useDeleteEvent(appid: number | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => req<void>(`/inputs/events/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["inputs", "events", appid] }),
  });
}

function useBenchmark(appid: number | null) {
  return useQuery({
    queryKey: ["inputs", "benchmark", appid],
    queryFn: () => req<WishlistBenchmark>(`/inputs/wishlist/benchmark?appid=${appid}`),
    enabled: appid !== null,
  });
}

// ---- small helpers ----------------------------------------------------------------------
const INPUT_CLS =
  "rounded-md border border-chartborder bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:border-series-1";
const BTN_CLS =
  "rounded-md bg-series-1 px-3 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function fmtDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** Tiny inline SVG sparkline of wishlist counts over the entered milestone points. */
function WishlistSpark({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const width = 260;
  const height = 52;
  const pad = 5;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1;
  const stepX = (width - pad * 2) / (values.length - 1);
  const coords = values.map((v, i) => {
    const x = pad + i * stepX;
    const y = pad + (1 - (v - min) / range) * (height - pad * 2);
    return [x, y] as const;
  });
  const line = coords.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${pad},${height - pad} ${line} ${(width - pad).toFixed(1)},${height - pad}`;
  const [lastX, lastY] = coords[coords.length - 1];
  const latest = values[values.length - 1];
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      height={height}
      preserveAspectRatio="none"
      role="img"
      aria-label={`Wishlist trend across ${values.length} recorded milestones, latest ${latest}`}
    >
      <polygon points={area} fill="var(--series-1)" opacity={0.08} />
      <polyline points={line} fill="none" stroke="var(--series-1)" strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={lastX} cy={lastY} r={3} fill="var(--series-1)" stroke="var(--surface-1)" strokeWidth={1.5} />
    </svg>
  );
}

// ---- game picker (search-based — the Dev Log no longer has a watchlist to pick from) -----
function GamePicker({ recent, onPick }: { recent: StoredGameMeta[]; onPick: (g: StoredGameMeta) => void }) {
  const [text, setText] = useState("");
  const [debounced, setDebounced] = useState("");
  const [focused, setFocused] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(text), 250);
    return () => window.clearTimeout(t);
  }, [text]);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setFocused(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const searchQ = useGameSearch({
    q: debounced || undefined,
    sort: "total_reviews",
    order: "desc",
    limit: 8,
    offset: 0,
  });
  const showResults = focused && debounced.trim().length >= 2;

  return (
    <div className="flex flex-col gap-2.5">
      {recent.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-ink-muted">Recent</span>
          {recent.map((g) => (
            <button
              key={g.appid}
              type="button"
              onClick={() => onPick(g)}
              className="rounded-full border border-chartborder px-2.5 py-1 text-xs font-medium text-ink-secondary transition-colors hover:border-series-1 hover:text-series-1"
            >
              {g.name ?? `App ${g.appid}`}
            </button>
          ))}
        </div>
      )}
      <div ref={boxRef} className="relative">
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onFocus={() => setFocused(true)}
          placeholder="Search for a game to log against…"
          className={`${INPUT_CLS} w-full min-w-[260px]`}
        />
        {showResults && (
          <div className="absolute z-20 mt-1 w-full min-w-[280px] overflow-hidden rounded-lg border border-chartborder bg-surface shadow-lg">
            {searchQ.isLoading && <div className="px-3 py-2 text-xs text-ink-muted">Searching…</div>}
            {searchQ.data && searchQ.data.items.length === 0 && (
              <div className="px-3 py-2 text-xs text-ink-muted">No games match “{debounced}”.</div>
            )}
            {searchQ.data &&
              searchQ.data.items.slice(0, 8).map((g) => (
                <button
                  key={g.appid}
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault(); // fires before the input's blur closes the list
                    onPick({ appid: g.appid, name: g.name, header_image: g.header_image, primary_genre: g.primary_genre });
                    setText("");
                    setDebounced("");
                    setFocused(false);
                  }}
                  className="flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-page"
                >
                  {g.header_image && (
                    <img src={g.header_image} alt="" loading="lazy" className="h-8 w-14 shrink-0 rounded-sm object-cover" />
                  )}
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-ink-primary">{g.name ?? `App ${g.appid}`}</span>
                    <span className="block truncate text-[11px] text-ink-muted">{g.primary_genre ?? "—"}</span>
                  </span>
                </button>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---- marketing timeline panel (server-backed — unchanged) --------------------------------
function MarketingPanel({ appid }: { appid: number }) {
  const { data, isLoading, isError, error } = useEvents(appid);
  const addEvent = useAddEvent(appid);
  const deleteEvent = useDeleteEvent(appid);

  const [eventDate, setEventDate] = useState(todayIso());
  const [kind, setKind] = useState<EventKind>("trailer");
  const [note, setNote] = useState("");

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!eventDate) return;
    addEvent.mutate(
      { appid, event_date: eventDate, kind, note: note.trim() || undefined },
      { onSuccess: () => setNote("") },
    );
  }

  return (
    <Card title="Marketing timeline" subtitle="Log the beats — trailers, festivals, press, updates — to read back against wishlist movement.">
      <form onSubmit={submit} className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-2">
          <label className="flex flex-col gap-1 text-xs text-ink-secondary">
            Date
            <input type="date" value={eventDate} max={todayIso()} onChange={(e) => setEventDate(e.target.value)} className={INPUT_CLS} />
          </label>
          <label className="flex flex-col gap-1 text-xs text-ink-secondary">
            Kind
            <select value={kind} onChange={(e) => setKind(e.target.value as EventKind)} className={INPUT_CLS}>
              {KIND_OPTIONS.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="flex flex-col gap-1 text-xs text-ink-secondary">
          Note
          <input
            type="text"
            value={note}
            placeholder="e.g. Announcement trailer live on YouTube"
            onChange={(e) => setNote(e.target.value)}
            className={INPUT_CLS}
          />
        </label>
        <div className="flex items-center gap-3">
          <button type="submit" disabled={addEvent.isPending || !eventDate} className={BTN_CLS}>
            {addEvent.isPending ? "Adding…" : "Add event"}
          </button>
          {addEvent.isError && (
            <span className="text-xs text-status-serious">
              {addEvent.error instanceof Error ? addEvent.error.message : "Failed to add event."}
            </span>
          )}
        </div>
      </form>

      <div className="mt-4 border-t border-chartborder pt-3">
        {isLoading && <div className="py-4 text-sm text-ink-muted">Loading events…</div>}
        {isError && (
          <div className="py-4 text-sm text-status-serious">
            Failed to load events{error instanceof Error ? `: ${error.message}` : "."}
          </div>
        )}
        {data && data.length === 0 && <div className="py-4 text-sm text-ink-muted">No marketing events logged yet.</div>}
        {data && data.length > 0 && (
          <ul className="flex flex-col">
            {data.map((ev) => (
              <li key={ev.id} className="flex items-start gap-3 border-b border-chartborder/60 py-2.5 last:border-0">
                <div className="tabular w-24 shrink-0 pt-0.5 text-xs text-ink-muted">{fmtDate(ev.event_date)}</div>
                <div className="min-w-0 flex-1">
                  <Badge color={KIND_COLOR[ev.kind] ?? "var(--text-muted)"}>{KIND_LABEL[ev.kind] ?? ev.kind}</Badge>
                  {ev.note && <p className="mt-1 break-words text-sm text-ink-secondary">{ev.note}</p>}
                </div>
                <button
                  type="button"
                  onClick={() => deleteEvent.mutate(ev.id)}
                  disabled={deleteEvent.isPending}
                  aria-label="Delete event"
                  className="shrink-0 rounded-md px-2 py-1 text-ink-muted hover:text-status-critical disabled:opacity-40"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

// ---- wishlist goal + benchmark (goal is local; suggested_target is the read-only server
// benchmark call) --------------------------------------------------------------------------
function GoalBenchmark({
  appid,
  goal,
  latest,
  onSetGoal,
  onClearGoal,
}: {
  appid: number;
  goal: StoredGoal | null;
  latest: number | null;
  onSetGoal: (target: number, note?: string) => void;
  onClearGoal: () => void;
}) {
  const benchmark = useBenchmark(appid);
  const [goalInput, setGoalInput] = useState("");
  const [showBasis, setShowBasis] = useState(false);

  const bench = benchmark.data;
  const suggested = bench?.suggested_target ?? null;
  const target = goal?.target ?? suggested;
  const pct = target && latest != null ? (latest / target) * 100 : null;
  const barPct = pct == null ? 0 : Math.max(0, Math.min(100, pct));
  const reached = pct != null && pct >= 100;

  function saveGoal(e: React.FormEvent) {
    e.preventDefault();
    const n = Math.floor(Number(goalInput.trim()));
    if (!Number.isFinite(n) || n <= 0) return;
    onSetGoal(n);
    setGoalInput("");
  }

  if (benchmark.isLoading) {
    return <div className="mb-4 rounded-lg border border-chartborder bg-surface2 p-3 text-sm text-ink-muted">Loading benchmark…</div>;
  }
  if (!bench || target == null) return null;

  return (
    <div className="mb-4 rounded-lg border border-chartborder bg-surface2 p-3">
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-xs font-medium text-ink-secondary">
          {goal ? "Your wishlist goal" : "Suggested wishlist target"}
        </div>
        <div className="tabular text-xs text-ink-muted">
          {latest != null ? fmtInt(latest) : "—"} / {fmtInt(target)}
        </div>
      </div>

      <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-page">
        <div
          className={`h-full rounded-full transition-[width] ${reached ? "bg-status-good" : "bg-brand"}`}
          style={{ width: `${barPct}%` }}
        />
      </div>
      <div className="mt-1 flex items-center justify-between text-[11px]">
        <span className={reached ? "font-medium text-status-good" : "text-ink-muted"}>
          {pct == null ? "No wishlist count recorded yet" : `${pct.toFixed(0)}% of target${reached ? " — reached" : ""}`}
        </span>
        <button
          type="button"
          onClick={() => setShowBasis((s) => !s)}
          className="text-ink-muted hover:text-ink-secondary"
        >
          {showBasis ? "Hide basis" : "How's this set?"}
        </button>
      </div>

      {showBasis && (
        <ul className="mt-2 flex list-disc flex-col gap-1 pl-4 text-[11px] leading-snug text-ink-muted">
          {bench.basis.map((b, i) => (
            <li key={i}>{b}</li>
          ))}
          <li className="italic">Rough heuristics, not guarantees — adjust to your own plan.</li>
        </ul>
      )}

      <form onSubmit={saveGoal} className="mt-3 flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs text-ink-secondary">
          Set your own goal
          <input
            type="number"
            min={1}
            value={goalInput}
            placeholder={suggested != null ? String(suggested) : "e.g. 10000"}
            onChange={(e) => setGoalInput(e.target.value)}
            className={`${INPUT_CLS} w-32`}
          />
        </label>
        <button type="submit" disabled={goalInput.trim() === ""} className={BTN_CLS}>
          {goal ? "Update goal" : "Set goal"}
        </button>
        {goal && (
          <button
            type="button"
            onClick={onClearGoal}
            className="rounded-md px-2 py-2 text-xs text-ink-muted hover:text-status-critical disabled:opacity-40"
          >
            Clear
          </button>
        )}
      </form>
      {goal && suggested != null && (
        <div className="mt-1 text-[11px] text-ink-muted">
          Tracking your goal of {fmtInt(goal.target)} · heuristic suggestion is {fmtInt(suggested)}.
        </div>
      )}
      <div className="mt-2 text-[10px] text-ink-muted">Saved in this browser only — not synced to an account.</div>
    </div>
  );
}

// ---- CSV bulk import (parsed client-side, saved to localStorage) -------------------------
function CsvImport({ onImport }: { onImport: (csv: string) => { imported: number; skipped: number; errors: string[] } }) {
  const [open, setOpen] = useState(false);
  const [csv, setCsv] = useState("");
  const [result, setResult] = useState<{ imported: number; skipped: number; errors: string[] } | null>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (csv.trim() === "") return;
    const r = onImport(csv);
    setResult(r);
    if (r.imported > 0) setCsv("");
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="mt-3 text-xs font-medium text-brand hover:underline">
        Paste CSV to bulk-import…
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="mt-3 rounded-lg border border-chartborder bg-surface2 p-3">
      <div className="flex items-center justify-between">
        <div className="text-xs font-medium text-ink-secondary">Bulk import milestones</div>
        <button type="button" onClick={() => setOpen(false)} className="text-xs text-ink-muted hover:text-ink-secondary">
          Close
        </button>
      </div>
      <p className="mt-1 text-[11px] text-ink-muted">
        One row per line: <span className="text-ink-secondary">YYYY-MM-DD,wishlists,followers</span> (followers optional). A header row is
        ignored and malformed lines are skipped.
      </p>
      <textarea
        value={csv}
        onChange={(e) => setCsv(e.target.value)}
        rows={5}
        spellCheck={false}
        placeholder={"2026-01-15,1200,140\n2026-02-15,3100,260"}
        className={`${INPUT_CLS} mt-2 w-full font-mono text-xs`}
      />
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <button type="submit" disabled={csv.trim() === ""} className={BTN_CLS}>
          Import
        </button>
        {result && (
          <span className="text-xs text-ink-secondary">
            Imported {result.imported}
            {result.skipped > 0 ? `, skipped ${result.skipped}` : ""}.
          </span>
        )}
      </div>
      {result && result.errors.length > 0 && (
        <ul className="mt-2 flex flex-col gap-0.5 text-[11px] text-status-warning">
          {result.errors.slice(0, 5).map((er, i) => (
            <li key={i}>{er}</li>
          ))}
          {result.errors.length > 5 && <li className="text-ink-muted">…and {result.errors.length - 5} more</li>}
        </ul>
      )}
    </form>
  );
}

// ---- wishlist milestones panel (local) ----------------------------------------------------
function WishlistPanel({
  appid,
  goal,
  milestones,
  onSetGoal,
  onClearGoal,
  onAddMilestones,
  onDeleteMilestone,
}: {
  appid: number;
  goal: StoredGoal | null;
  milestones: StoredMilestone[];
  onSetGoal: (target: number, note?: string) => void;
  onClearGoal: () => void;
  onAddMilestones: (rows: Omit<StoredMilestone, "id" | "created_at">[]) => void;
  onDeleteMilestone: (id: string) => void;
}) {
  const [onDate, setOnDate] = useState(todayIso());
  const [wishlists, setWishlists] = useState("");
  const [followers, setFollowers] = useState("");

  function parseFieldCount(raw: string): number | undefined {
    const n = parseCount(raw);
    return n === null ? undefined : n;
  }

  const wl = parseFieldCount(wishlists);
  const fl = parseFieldCount(followers);
  const canSubmit = !!onDate && (wl !== undefined || fl !== undefined);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    onAddMilestones([{ on_date: onDate, wishlists: wl ?? null, followers: fl ?? null, source: "manual" }]);
    setWishlists("");
    setFollowers("");
  }

  function importCsv(csv: string) {
    const parsed = parseWishlistCsv(csv);
    onAddMilestones(parsed.rows);
    return { imported: parsed.rows.length, skipped: parsed.skipped, errors: parsed.errors };
  }

  const latest = useMemo(() => {
    const withCounts = milestones.filter((m) => m.wishlists != null);
    return withCounts.length > 0 ? (withCounts[withCounts.length - 1].wishlists as number) : null;
  }, [milestones]);

  const sparkValues = useMemo(
    () => milestones.filter((m) => m.wishlists != null).map((m) => m.wishlists as number),
    [milestones],
  );

  return (
    <Card title="Wishlist milestones" subtitle="Manual wishlist / follower counts, saved in this browser — no account sync yet.">
      <GoalBenchmark appid={appid} goal={goal} latest={latest} onSetGoal={onSetGoal} onClearGoal={onClearGoal} />
      <form onSubmit={submit} className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-2">
          <label className="flex flex-col gap-1 text-xs text-ink-secondary">
            Date
            <input type="date" value={onDate} max={todayIso()} onChange={(e) => setOnDate(e.target.value)} className={INPUT_CLS} />
          </label>
          <label className="flex flex-col gap-1 text-xs text-ink-secondary">
            Wishlists
            <input type="number" min={0} value={wishlists} placeholder="—" onChange={(e) => setWishlists(e.target.value)} className={`${INPUT_CLS} w-28`} />
          </label>
          <label className="flex flex-col gap-1 text-xs text-ink-secondary">
            Followers
            <input type="number" min={0} value={followers} placeholder="—" onChange={(e) => setFollowers(e.target.value)} className={`${INPUT_CLS} w-28`} />
          </label>
        </div>
        <div className="flex items-center gap-3">
          <button type="submit" disabled={!canSubmit} className={BTN_CLS}>
            Add milestone
          </button>
        </div>
      </form>

      <CsvImport onImport={importCsv} />

      {sparkValues.length >= 2 && (
        <div className="mt-4">
          <div className="mb-1 text-xs text-ink-muted">Wishlists over time</div>
          <WishlistSpark values={sparkValues} />
        </div>
      )}

      <div className="mt-4 border-t border-chartborder pt-3">
        {milestones.length === 0 && <div className="py-4 text-sm text-ink-muted">No milestones recorded yet.</div>}
        {milestones.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-chartborder text-left text-xs text-ink-muted">
                  <th className="px-2 py-1.5 font-medium">Date</th>
                  <th className="px-2 py-1.5 text-right font-medium">Wishlists</th>
                  <th className="px-2 py-1.5 text-right font-medium">Followers</th>
                  <th className="px-2 py-1.5 font-medium" />
                </tr>
              </thead>
              <tbody>
                {milestones.map((m) => (
                  <tr key={m.id} className="border-b border-chartborder/60 hover:bg-page">
                    <td className="tabular px-2 py-1.5">{fmtDate(m.on_date)}</td>
                    <td className="tabular px-2 py-1.5 text-right">{m.wishlists != null ? fmtInt(m.wishlists) : "—"}</td>
                    <td className="tabular px-2 py-1.5 text-right">{m.followers != null ? fmtInt(m.followers) : "—"}</td>
                    <td className="px-2 py-1.5 text-right">
                      <button
                        type="button"
                        onClick={() => onDeleteMilestone(m.id)}
                        aria-label="Delete milestone"
                        className="rounded-md px-2 py-0.5 text-ink-muted hover:text-status-critical disabled:opacity-40"
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Card>
  );
}

// ---- page -------------------------------------------------------------------------------
export default function DevLog() {
  const store = useDevLogStore();
  const [appid, setAppid] = useState<number | null>(null);

  // Default to the most recently used game once the store loads (and keep the selection valid).
  useEffect(() => {
    if (store.state.recentGames.length === 0) return;
    setAppid((cur) =>
      cur !== null && store.state.recentGames.some((g) => g.appid === cur) ? cur : store.state.recentGames[0].appid,
    );
    // Only re-derive the default on the recent-games list changing, not every store update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.state.recentGames]);

  const selected = useMemo(
    () => store.state.recentGames.find((g) => g.appid === appid) ?? null,
    [store.state.recentGames, appid],
  );
  const appidKey = appid !== null ? String(appid) : null;
  const goal = appidKey ? store.state.goals[appidKey] ?? null : null;
  const milestones = appidKey ? store.state.milestones[appidKey] ?? [] : [];

  function pickGame(g: StoredGameMeta) {
    store.touchGame(g);
    setAppid(g.appid);
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold text-ink-primary">Dev log</h1>
        <p className="mt-0.5 text-sm text-ink-muted">
          Record your own marketing beats and wishlist milestones for a game you're tracking, then read them back together.
          Wishlist goals and milestones are saved in this browser only; marketing events sync to your account.
        </p>
      </div>

      <Card className="!p-4">
        <GamePicker recent={store.state.recentGames} onPick={pickGame} />
      </Card>

      {store.state.recentGames.length === 0 && (
        <Card>
          <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-ink-muted">
            <span>No games logged yet — search above for a game to start tracking it.</span>
            <Link to="/games" className="text-series-1 hover:underline">
              Browse the game catalog
            </Link>
          </div>
        </Card>
      )}

      {selected && appid !== null && (
        <>
          <Card className="!p-3">
            <div className="flex items-center gap-2.5">
              {selected.header_image && (
                <img src={selected.header_image} alt="" loading="lazy" className="h-9 w-16 shrink-0 rounded-sm object-cover" />
              )}
              <div className="leading-tight">
                <div className="text-sm font-medium text-ink-primary">{selected.name ?? `App ${selected.appid}`}</div>
                <div className="text-[11px] text-ink-muted">{selected.primary_genre ?? "—"}</div>
              </div>
            </div>
          </Card>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <MarketingPanel key={`m-${appid}`} appid={appid} />
            <WishlistPanel
              key={`w-${appid}`}
              appid={appid}
              goal={goal}
              milestones={milestones}
              onSetGoal={(target, note) => store.setGoal(appid, target, note)}
              onClearGoal={() => store.clearGoal(appid)}
              onAddMilestones={(rows) => store.addMilestones(appid, rows)}
              onDeleteMilestone={(id) => store.deleteMilestone(appid, id)}
            />
          </div>
        </>
      )}
    </div>
  );
}
