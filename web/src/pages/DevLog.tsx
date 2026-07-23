import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { Badge } from "../components/ui/Badge";
import { Card } from "../components/ui/Card";
import { API_BASE, ApiError } from "../lib/api";
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

// ---- types ------------------------------------------------------------------------------
interface GamePick {
  appid: number;
  name: string | null;
  header_image: string | null;
  primary_genre: string | null;
}

type EventKind = "trailer" | "festival" | "press" | "update" | "other";

interface MarketingEvent {
  id: number;
  appid: number;
  event_date: string;
  kind: string;
  note: string | null;
  created_at: string;
}

interface WishlistMilestone {
  id: number;
  appid: number;
  on_date: string;
  wishlists: number | null;
  followers: number | null;
  source: string;
  created_at: string;
}

interface WishlistBenchmark {
  appid: number;
  primary_genre: string | null;
  suggested_target: number;
  basis: string[];
  latest_wishlists: number | null;
  pct_to_target: number | null;
}

interface WishlistGoal {
  appid: number;
  target: number;
  note: string | null;
  updated_at: string;
}

interface ImportResult {
  imported: number;
  skipped: number;
  errors: string[];
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

// ---- hooks ------------------------------------------------------------------------------
function useDevGames() {
  return useQuery({ queryKey: ["inputs", "games"], queryFn: () => req<GamePick[]>("/inputs/games") });
}

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

function useMilestones(appid: number | null) {
  return useQuery({
    queryKey: ["inputs", "wishlist", appid],
    queryFn: () => req<WishlistMilestone[]>(`/inputs/wishlist?appid=${appid}`),
    enabled: appid !== null,
  });
}

function useAddMilestone(appid: number | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { appid: number; on_date: string; wishlists?: number; followers?: number }) =>
      req<WishlistMilestone>("/inputs/wishlist", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["inputs", "wishlist", appid] }),
  });
}

function useDeleteMilestone(appid: number | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => req<void>(`/inputs/wishlist/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["inputs", "wishlist", appid] }),
  });
}

function useBenchmark(appid: number | null) {
  return useQuery({
    queryKey: ["inputs", "benchmark", appid],
    queryFn: () => req<WishlistBenchmark>(`/inputs/wishlist/benchmark?appid=${appid}`),
    enabled: appid !== null,
  });
}

function useGoal(appid: number | null) {
  return useQuery({
    queryKey: ["inputs", "goal", appid],
    queryFn: () => req<WishlistGoal | null>(`/inputs/wishlist/goal?appid=${appid}`),
    enabled: appid !== null,
  });
}

function useSetGoal(appid: number | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { appid: number; target: number; note?: string }) =>
      req<WishlistGoal>("/inputs/wishlist/goal", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["inputs", "goal", appid] });
      qc.invalidateQueries({ queryKey: ["inputs", "benchmark", appid] });
    },
  });
}

function useClearGoal(appid: number | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => req<void>(`/inputs/wishlist/goal?appid=${appid}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["inputs", "goal", appid] });
      qc.invalidateQueries({ queryKey: ["inputs", "benchmark", appid] });
    },
  });
}

function useImportCsv(appid: number | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (csv: string) =>
      req<ImportResult>("/inputs/wishlist/import", {
        method: "POST",
        body: JSON.stringify({ appid, csv }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["inputs", "wishlist", appid] });
      qc.invalidateQueries({ queryKey: ["inputs", "benchmark", appid] });
    },
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
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      height={height}
      preserveAspectRatio="none"
      role="img"
      aria-label={`Wishlist trend across ${values.length} recorded milestones, latest ${values[values.length - 1]}`}
    >
      <polygon points={area} fill="var(--series-1)" opacity={0.08} />
      <polyline points={line} fill="none" stroke="var(--series-1)" strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={lastX} cy={lastY} r={3} fill="var(--series-1)" stroke="var(--surface-1)" strokeWidth={1.5} />
    </svg>
  );
}

// ---- marketing timeline panel -----------------------------------------------------------
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

// ---- wishlist goal + benchmark ----------------------------------------------------------
function GoalBenchmark({ appid }: { appid: number }) {
  const benchmark = useBenchmark(appid);
  const goalQuery = useGoal(appid);
  const setGoal = useSetGoal(appid);
  const clearGoal = useClearGoal(appid);

  const [goalInput, setGoalInput] = useState("");
  const [showBasis, setShowBasis] = useState(false);

  const bench = benchmark.data;
  const goal = goalQuery.data ?? null;

  // Active target = the dev's own goal if they've set one, else the heuristic suggestion.
  const suggested = bench?.suggested_target ?? null;
  const target = goal?.target ?? suggested;
  const latest = bench?.latest_wishlists ?? null;
  const pct = target && latest != null ? (latest / target) * 100 : null;
  const barPct = pct == null ? 0 : Math.max(0, Math.min(100, pct));
  const reached = pct != null && pct >= 100;

  function saveGoal(e: React.FormEvent) {
    e.preventDefault();
    const n = Math.floor(Number(goalInput.trim()));
    if (!Number.isFinite(n) || n <= 0) return;
    setGoal.mutate({ appid, target: n }, { onSuccess: () => setGoalInput("") });
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
        <button type="submit" disabled={setGoal.isPending || goalInput.trim() === ""} className={BTN_CLS}>
          {setGoal.isPending ? "Saving…" : goal ? "Update goal" : "Set goal"}
        </button>
        {goal && (
          <button
            type="button"
            onClick={() => clearGoal.mutate()}
            disabled={clearGoal.isPending}
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
    </div>
  );
}

// ---- CSV bulk import --------------------------------------------------------------------
function CsvImport({ appid }: { appid: number }) {
  const importCsv = useImportCsv(appid);
  const [open, setOpen] = useState(false);
  const [csv, setCsv] = useState("");
  const [result, setResult] = useState<ImportResult | null>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (csv.trim() === "") return;
    importCsv.mutate(csv, {
      onSuccess: (r) => {
        setResult(r);
        if (r.imported > 0) setCsv("");
      },
    });
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
        <button type="submit" disabled={importCsv.isPending || csv.trim() === ""} className={BTN_CLS}>
          {importCsv.isPending ? "Importing…" : "Import"}
        </button>
        {importCsv.isError && (
          <span className="text-xs text-status-serious">
            {importCsv.error instanceof Error ? importCsv.error.message : "Import failed."}
          </span>
        )}
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

// ---- wishlist milestones panel ----------------------------------------------------------
function WishlistPanel({ appid }: { appid: number }) {
  const { data, isLoading, isError, error } = useMilestones(appid);
  const addMilestone = useAddMilestone(appid);
  const deleteMilestone = useDeleteMilestone(appid);

  const [onDate, setOnDate] = useState(todayIso());
  const [wishlists, setWishlists] = useState("");
  const [followers, setFollowers] = useState("");

  function parseCount(raw: string): number | undefined {
    const t = raw.trim();
    if (t === "") return undefined;
    const n = Math.floor(Number(t));
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  }

  const wl = parseCount(wishlists);
  const fl = parseCount(followers);
  const canSubmit = !!onDate && (wl !== undefined || fl !== undefined);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    addMilestone.mutate(
      { appid, on_date: onDate, wishlists: wl, followers: fl },
      {
        onSuccess: () => {
          setWishlists("");
          setFollowers("");
        },
      },
    );
  }

  // API returns milestones oldest -> newest; sparkline follows that order.
  const sparkValues = useMemo(
    () => (data ?? []).filter((m) => m.wishlists != null).map((m) => m.wishlists as number),
    [data],
  );

  return (
    <Card title="Wishlist milestones" subtitle="Manual wishlist / follower counts — the fallback log until an automated Steamworks ingest lands.">
      <GoalBenchmark appid={appid} />
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
          <button type="submit" disabled={addMilestone.isPending || !canSubmit} className={BTN_CLS}>
            {addMilestone.isPending ? "Adding…" : "Add milestone"}
          </button>
          {addMilestone.isError && (
            <span className="text-xs text-status-serious">
              {addMilestone.error instanceof Error ? addMilestone.error.message : "Failed to add milestone."}
            </span>
          )}
        </div>
      </form>

      <CsvImport appid={appid} />

      {sparkValues.length >= 2 && (
        <div className="mt-4">
          <div className="mb-1 text-xs text-ink-muted">Wishlists over time</div>
          <WishlistSpark values={sparkValues} />
        </div>
      )}

      <div className="mt-4 border-t border-chartborder pt-3">
        {isLoading && <div className="py-4 text-sm text-ink-muted">Loading milestones…</div>}
        {isError && (
          <div className="py-4 text-sm text-status-serious">
            Failed to load milestones{error instanceof Error ? `: ${error.message}` : "."}
          </div>
        )}
        {data && data.length === 0 && <div className="py-4 text-sm text-ink-muted">No milestones recorded yet.</div>}
        {data && data.length > 0 && (
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
                {data.map((m) => (
                  <tr key={m.id} className="border-b border-chartborder/60 hover:bg-page">
                    <td className="tabular px-2 py-1.5">{fmtDate(m.on_date)}</td>
                    <td className="tabular px-2 py-1.5 text-right">{m.wishlists != null ? fmtInt(m.wishlists) : "—"}</td>
                    <td className="tabular px-2 py-1.5 text-right">{m.followers != null ? fmtInt(m.followers) : "—"}</td>
                    <td className="px-2 py-1.5 text-right">
                      <button
                        type="button"
                        onClick={() => deleteMilestone.mutate(m.id)}
                        disabled={deleteMilestone.isPending}
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
  const { data: games, isLoading, isError, error } = useDevGames();
  const [appid, setAppid] = useState<number | null>(null);

  // Default to the first watched game once the list arrives (and keep the selection valid).
  useEffect(() => {
    if (!games || games.length === 0) return;
    setAppid((cur) => (cur !== null && games.some((g) => g.appid === cur) ? cur : games[0].appid));
  }, [games]);

  const selected = useMemo(() => games?.find((g) => g.appid === appid) ?? null, [games, appid]);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold text-ink-primary">Dev log</h1>
        <p className="mt-0.5 text-sm text-ink-muted">
          Record your own marketing beats and wishlist milestones for a game you're tracking, then read them back together.
        </p>
      </div>

      {isLoading && <Card><div className="py-6 text-sm text-ink-muted">Loading your games…</div></Card>}
      {isError && (
        <Card>
          <div className="py-6 text-sm text-status-serious">
            Failed to load games{error instanceof Error ? `: ${error.message}` : "."}
          </div>
        </Card>
      )}

      {games && games.length === 0 && (
        <Card>
          <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-ink-muted">
            <span>No games to log against yet — the dev log tracks games on your watchlist.</span>
            <Link to="/watchlist" className="text-series-1 hover:underline">
              Go to your watchlist
            </Link>
          </div>
        </Card>
      )}

      {games && games.length > 0 && (
        <>
          <Card className="!p-4">
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex flex-col gap-1 text-xs text-ink-secondary">
                Game
                <select
                  value={appid ?? ""}
                  onChange={(e) => setAppid(Number(e.target.value))}
                  className={`${INPUT_CLS} min-w-[240px]`}
                >
                  {games.map((g) => (
                    <option key={g.appid} value={g.appid}>
                      {g.name ?? `App ${g.appid}`}
                    </option>
                  ))}
                </select>
              </label>
              {selected && (
                <div className="flex items-center gap-2.5">
                  {selected.header_image && (
                    <img src={selected.header_image} alt="" loading="lazy" className="h-9 w-16 shrink-0 rounded-sm object-cover" />
                  )}
                  <div className="leading-tight">
                    <div className="text-sm font-medium text-ink-primary">{selected.name ?? `App ${selected.appid}`}</div>
                    <div className="text-[11px] text-ink-muted">{selected.primary_genre ?? "—"}</div>
                  </div>
                </div>
              )}
            </div>
          </Card>

          {appid !== null && (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <MarketingPanel key={`m-${appid}`} appid={appid} />
              <WishlistPanel key={`w-${appid}`} appid={appid} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
