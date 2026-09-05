import { useQuery } from "@tanstack/react-query";

import { Card } from "../components/ui/Card";
import { ErrorState } from "../components/ui/ErrorState";
import { Loading } from "../components/ui/Loading";
import { request } from "../lib/api";
import { usePageTitle } from "../lib/usePageTitle";

type Counts = { games?: number; reviews?: number; players?: number };

/**
 * The nightly's verdict for one run (deploy/prospect-refresh.sh). OK and FAILED ran the
 * pipeline. HELD (a build hold was on) and SKIPPED (the refresh lock was already held)
 * never started it: nothing was scraped, built or restarted and the previous mart stayed in
 * service — a neutral state on this page, not a failure. A value the page doesn't know gets
 * the FAILED treatment: an unrecognised verdict is not something to paint green or grey.
 */
type RunResult = "OK" | "FAILED" | "HELD" | "SKIPPED";

type Run = {
  finished_at: string;
  result: RunResult;
  duration_s?: number;
  step?: string;
  /** Newest mart on disk when the run ended (null before the first build). */
  mart_version?: string | null;
  /** The mart the app was actually serving when the run ended. Worth a word only when it
   * is NOT mart_version — a build that published and then failed to bring the app back. */
  serving_version?: string | null;
  /** HELD / SKIPPED: why nothing ran — "lock held: …" or the first line of the hold note. */
  reason?: string | null;
  etl_rc?: number | null;
  etl_duration_s?: number | null;
  /** FAILED: the last error line of the ETL log (the writer caps it at 300 chars). */
  error?: string | null;
  // Absent (not null) on HELD / SKIPPED rows — there was no run to count or diff.
  counts?: Counts;
  deltas?: Counts;
  freshness_hours?: Record<string, number | null>;
};

type Tone = "good" | "neutral" | "bad";

function toneOf(result: string): Tone {
  if (result === "OK") return "good";
  if (result === "HELD" || result === "SKIPPED") return "neutral";
  return "bad";
}

// Text-safe tokens only: the dot paints itself with currentColor off the same class.
const TONE_CLASS: Record<Tone, string> = {
  good: "text-verdict-good",
  neutral: "text-ink-muted",
  bad: "text-verdict-serious",
};

function labelOf(result: string): string {
  if (result === "OK") return "success";
  if (result === "HELD") return "held";
  if (result === "SKIPPED") return "skipped";
  return "failed";
}

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

function DeltaSummary({ deltas }: { deltas?: Counts }) {
  // An empty deltas object means there was no previous run to diff against — this is the
  // baseline snapshot, NOT a no-op refresh. A populated deltas that's all-zero is a real
  // "nothing changed" run.
  const hasPrior = deltas != null && Object.keys(deltas).length > 0;
  const active = DELTA_FIELDS.filter((f) => (deltas?.[f.key] ?? 0) !== 0);
  if (!hasPrior) {
    return <span className="text-xs text-ink-muted">Baseline snapshot — first recorded run (totals below).</span>;
  }
  if (active.length === 0) {
    return <span className="text-xs text-ink-muted">No changes since the previous run.</span>;
  }
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
  usePageTitle("Data log");
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["refresh-history"],
    queryFn: ({ signal }) => request<{ runs: Run[] }>("/refresh/history", { signal }),
  });
  const runs = data?.runs ?? [];

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-10">
      <div>
        <h1 className="text-lg font-semibold text-ink-primary">Data log</h1>
        <p className="mt-1 text-sm text-ink-muted">
          What each nightly refresh changed. The pipeline re-scrapes Steam, rebuilds the marts, and
          reloads the app every night — it starts at 21:00&nbsp;UTC and usually finishes between
          00:45 and 03:30&nbsp;UTC.
        </p>
      </div>

      {isLoading ? (
        <Card className="py-10">
          <Loading className="text-sm" />
        </Card>
      ) : isError ? (
        // This page never leaked a raw exception, but it was still a dead end: no retry on
        // any of the seven routes checked 2026-09-01.
        <Card className="py-4">
          <ErrorState title="Couldn’t load the refresh log" error={error} onRetry={() => void refetch()} />
        </Card>
      ) : runs.length === 0 ? (
        <Card className="flex flex-col items-center gap-2 py-12 text-center">
          <p className="text-sm font-medium text-ink-primary">No refreshes recorded yet</p>
          <p className="max-w-sm text-xs text-ink-muted">
            The nightly run starts at 21:00&nbsp;UTC. Once one completes, every run shows up here
            with the data it added.
          </p>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {runs.map((r, i) => {
            const tone = toneOf(r.result);
            const ran = tone !== "neutral"; // HELD / SKIPPED never started the pipeline
            const dt = new Date(r.finished_at);
            const serving = r.serving_version && r.serving_version !== r.mart_version ? r.serving_version : null;
            return (
              <Card key={r.finished_at + i} className="flex flex-col gap-2.5">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <span
                      className={`inline-block h-2 w-2 rounded-full ${TONE_CLASS[tone]}`}
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
                    className={`rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${TONE_CLASS[tone]}`}
                  >
                    {labelOf(r.result)}
                  </span>
                </div>

                {ran ? (
                  <DeltaSummary deltas={r.deltas} />
                ) : (
                  // These rows have no deltas key at all; DeltaSummary would read that as
                  // the baseline snapshot, which is a claim about a run that never happened.
                  <span className="text-xs text-ink-muted">Nothing ran — the previous mart stayed in service.</span>
                )}

                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-muted">
                  {r.mart_version && (
                    <span>
                      mart <code className="text-ink-secondary">{r.mart_version}</code>
                    </span>
                  )}
                  {serving && (
                    <span>
                      serving <code className="text-ink-secondary">{serving}</code>
                    </span>
                  )}
                  {r.counts?.games !== undefined && <span>{nf.format(r.counts.games)} games total</span>}
                  {r.counts?.reviews !== undefined && <span>{nf.format(r.counts.reviews)} reviews total</span>}
                  {ran && r.duration_s !== undefined && <span>took {fmtDur(r.duration_s)}</span>}
                  {tone === "bad" && r.step && (
                    <span className="text-verdict-serious">
                      stopped at: {r.step}
                      {typeof r.etl_rc === "number" && r.etl_rc !== 0 ? ` (rc ${r.etl_rc})` : ""}
                    </span>
                  )}
                  {tone === "neutral" && r.reason && <span>{r.reason}</span>}
                </div>

                {tone === "bad" && r.error && (
                  <p className="truncate font-mono text-[11px] text-ink-muted" title={r.error}>
                    {r.error}
                  </p>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
