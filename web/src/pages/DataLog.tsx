import { useQuery } from "@tanstack/react-query";

import { Card } from "../components/ui/Card";
import { request } from "../lib/api";

type Counts = { games?: number; reviews?: number; players?: number };
type Run = {
  finished_at: string;
  result: string; // "OK" | "FAILED"
  duration_s?: number;
  mart_version?: string;
  step?: string;
  counts?: Counts;
  deltas?: Counts;
};

const nf = new Intl.NumberFormat("en-US");

function relTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso || "—";
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : `${d}d ago`;
}

function fmtDur(s?: number): string {
  if (s === undefined || s === null) return "";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m}m ${r}s` : `${m}m`;
}

function signed(n: number): string {
  return (n > 0 ? "+" : "") + nf.format(n);
}

const DELTA_FIELDS: { key: keyof Counts; label: string }[] = [
  { key: "games", label: "games" },
  { key: "reviews", label: "reviews" },
  { key: "players", label: "player updates" },
];

function DeltaChips({ deltas }: { deltas?: Counts }) {
  const active = DELTA_FIELDS.filter((f) => (deltas?.[f.key] ?? 0) !== 0);
  if (active.length === 0) return <span className="text-xs text-ink-muted">No new data this run.</span>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {active.map((f) => {
        const v = deltas![f.key]!;
        const up = v > 0;
        return (
          <span
            key={f.key}
            className={`rounded-full px-2 py-0.5 text-xs font-medium ${up ? "bg-brand-tint text-brand" : "bg-surface2 text-ink-secondary"}`}
          >
            {signed(v)} {f.label}
          </span>
        );
      })}
    </div>
  );
}

export default function DataLog() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["refresh-history"],
    queryFn: () => request<{ runs: Run[] }>("/refresh/history"),
  });
  const runs = data?.runs ?? [];

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-10">
      <div>
        <h1 className="text-lg font-semibold text-ink-primary">Data log</h1>
        <p className="mt-1 text-sm text-ink-muted">
          What each nightly refresh changed. The pipeline re-scrapes Steam, rebuilds the marts, and
          reloads the app every day at 04:00&nbsp;UTC.
        </p>
      </div>

      {isLoading ? (
        <Card className="py-10 text-center text-sm text-ink-muted">Loading…</Card>
      ) : isError ? (
        <Card className="py-10 text-center text-sm text-status-critical">Couldn’t load the refresh log.</Card>
      ) : runs.length === 0 ? (
        <Card className="flex flex-col items-center gap-2 py-12 text-center">
          <p className="text-sm font-medium text-ink-primary">No refreshes recorded yet</p>
          <p className="max-w-sm text-xs text-ink-muted">
            The first daily run is scheduled for 04:00&nbsp;UTC. Once it completes, every run shows up
            here with the data it added.
          </p>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {runs.map((r, i) => {
            const ok = r.result === "OK";
            const dt = new Date(r.finished_at);
            return (
              <Card key={r.finished_at + i} className="flex flex-col gap-2.5">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <span
                      className={`inline-block h-2 w-2 rounded-full ${ok ? "text-status-good" : "text-status-critical"}`}
                      style={{ backgroundColor: "currentColor" }}
                    />
                    <span className="text-sm font-semibold text-ink-primary">{relTime(r.finished_at)}</span>
                    <span className="text-xs text-ink-muted">
                      {Number.isNaN(dt.getTime())
                        ? ""
                        : dt.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
                    </span>
                  </div>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${ok ? "text-status-good" : "text-status-critical"}`}
                  >
                    {ok ? "success" : "failed"}
                  </span>
                </div>

                <DeltaChips deltas={r.deltas} />

                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-muted">
                  {r.mart_version && (
                    <span>
                      mart <code className="text-ink-secondary">{r.mart_version}</code>
                    </span>
                  )}
                  {r.counts?.games !== undefined && <span>{nf.format(r.counts.games)} games total</span>}
                  {r.counts?.reviews !== undefined && <span>{nf.format(r.counts.reviews)} reviews total</span>}
                  {r.duration_s !== undefined && <span>took {fmtDur(r.duration_s)}</span>}
                  {!ok && r.step && <span className="text-status-critical">stopped at: {r.step}</span>}
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
