import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import clsx from "clsx";

import { Badge } from "../components/ui/Badge";
import { Card } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { API_BASE } from "../lib/api";
import { monthName } from "../lib/format";

// ---- types (mirror api/app/routers/radar.py's RadarResponse) ----------------------------
interface RadarEvent {
  id: string;
  name: string;
  type: string;
  start_date: string;
  end_date: string;
  submission_deadline: string | null;
  url: string | null;
  note: string;
  prep: string[];
  days_until_start: number;
  days_until_end: number;
  days_until_deadline: number | null;
}

interface RadarTypeCount {
  type: string;
  count: number;
}

interface RadarResponse {
  today: string;
  applied_type: string | null;
  available_types: RadarTypeCount[];
  upcoming: RadarEvent[];
  recent_past: RadarEvent[];
}

// `request` in lib/api.ts is module-private, so this surface fetches through the exported
// API_BASE (same Vite dev proxy, same-origin) with a tiny local reader — no edit to api.ts.
// An optional `type` narrows to one event kind (server-side ?type= filter).
async function fetchRadar(type: string | null): Promise<RadarResponse> {
  const q = type ? `?type=${encodeURIComponent(type)}` : "";
  const res = await fetch(`${API_BASE}/radar${q}`, {
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`Radar request failed (HTTP ${res.status})`);
  return (await res.json()) as RadarResponse;
}

function useRadar(type: string | null) {
  return useQuery({
    queryKey: ["radar", type],
    queryFn: () => fetchRadar(type),
    staleTime: 5 * 60_000,
    // Keep the prior result visible while switching type filters so the chips/list don't flicker.
    placeholderData: keepPreviousData,
  });
}

// ---- per-type identity (validated categorical hues from the palette) ---------------------
const TYPE_META: Record<string, { label: string; color: string }> = {
  next_fest: { label: "Next Fest", color: "var(--series-1)" },
  steam_sale: { label: "Steam Sale", color: "var(--series-3)" },
  festival: { label: "Festival", color: "var(--series-5)" },
  awards: { label: "Awards", color: "var(--series-7)" },
};
function typeMeta(t: string) {
  return TYPE_META[t] ?? { label: t, color: "var(--text-muted)" };
}

// Thresholds that drive the "act now" emphasis.
const URGENT_START_DAYS = 14;
const SOON_DEADLINE_DAYS = 21;

// ---- date helpers (parse "YYYY-MM-DD" manually to avoid UTC/local off-by-one) ------------
function ymd(d: string): [number, number, number] {
  const [y, m, day] = d.split("-").map(Number);
  return [y, m, day];
}
function fmtLong(d: string): string {
  const [y, m, day] = ymd(d);
  return `${monthName(m)} ${day}, ${y}`;
}
function fmtShort(d: string): string {
  const [, m, day] = ymd(d);
  return `${monthName(m)} ${day}`;
}
function fmtRange(start: string, end: string): string {
  if (start === end) return fmtLong(start);
  const [sy, sm, sd] = ymd(start);
  const [ey, em, ed] = ymd(end);
  if (sy === ey && sm === em) return `${monthName(sm)} ${sd}–${ed}, ${sy}`;
  if (sy === ey) return `${fmtShort(start)} – ${fmtShort(end)}, ${sy}`;
  return `${fmtLong(start)} – ${fmtLong(end)}`;
}
function daysLabel(n: number): string {
  if (n === 0) return "Today";
  if (n === 1) return "Tomorrow";
  if (n === -1) return "Yesterday";
  if (n < 0) return `${-n} days ago`;
  return `in ${n} days`;
}

// ---- small pieces -----------------------------------------------------------------------
function DaysChip({ days }: { days: number }) {
  const urgent = days >= 0 && days < URGENT_START_DAYS;
  return (
    <span
      className={clsx(
        "tabular inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
        days < 0 && "bg-surface2 text-ink-muted",
        days >= 0 && !urgent && "bg-surface2 text-ink-secondary",
        urgent && "border border-status-warning text-status-warning",
      )}
    >
      {daysLabel(days)}
    </span>
  );
}

function ClockIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-3.5 w-3.5 shrink-0"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5V12l3 2" />
    </svg>
  );
}

function DeadlineRow({ event }: { event: RadarEvent }) {
  if (!event.submission_deadline || event.days_until_deadline === null) return null;
  const d = event.days_until_deadline;
  const passed = d < 0;
  const soon = d >= 0 && d < SOON_DEADLINE_DAYS;
  return (
    <div
      className={clsx(
        "mt-2 inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs",
        soon ? "border-status-warning text-status-warning" : "border-chartborder bg-page text-ink-secondary",
        passed && "text-ink-muted",
      )}
    >
      <ClockIcon />
      {passed ? (
        <span>Submission window closed — deadline was {fmtLong(event.submission_deadline)}</span>
      ) : (
        <span>
          Submit / opt in by {fmtLong(event.submission_deadline)} ·{" "}
          <span className="font-semibold">{daysLabel(d)}</span>
        </span>
      )}
    </div>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={clsx("h-3.5 w-3.5 shrink-0 transition-transform", open && "rotate-90")}
    >
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

function CheckCircleIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-muted"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="m8.5 12.5 2.5 2.5 4.5-5" />
    </svg>
  );
}

// A filter chip: identity dot + label + count. Active = brand-tinted.
function TypeChip({
  label,
  count,
  color,
  active,
  onClick,
}: {
  label: string;
  count: number;
  color?: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={clsx(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
        active
          ? "border-brand bg-brand-tint text-brand"
          : "border-chartborder text-ink-secondary hover:bg-surface2 hover:text-ink-primary",
      )}
    >
      {color && <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />}
      {label}
      <span className="tabular text-ink-muted">{count}</span>
    </button>
  );
}

function EventRow({ event }: { event: RadarEvent }) {
  const meta = typeMeta(event.type);
  const [sy, sm, sd] = ymd(event.start_date);
  const [open, setOpen] = useState(false);
  const hasPrep = event.prep.length > 0;
  return (
    <div className="flex gap-4 rounded-card border border-chartborder bg-surface p-4 shadow-xs">
      {/* Date rail */}
      <div className="w-12 shrink-0 text-center">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">{monthName(sm)}</div>
        <div className="tabular text-2xl font-semibold leading-tight text-ink-primary">{sd}</div>
        <div className="tabular text-[11px] text-ink-muted">{sy}</div>
      </div>

      {/* Body */}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Badge color={meta.color}>{meta.label}</Badge>
          <DaysChip days={event.days_until_start} />
          <span className="text-xs text-ink-muted">{fmtRange(event.start_date, event.end_date)}</span>
        </div>

        <h3 className="mt-1.5 text-sm font-semibold text-ink-primary">
          {event.url ? (
            <a
              href={event.url}
              target="_blank"
              rel="noreferrer"
              className="hover:text-series-1 hover:underline"
            >
              {event.name}
            </a>
          ) : (
            event.name
          )}
        </h3>

        <p className="mt-1 text-sm leading-relaxed text-ink-secondary">{event.note}</p>

        <DeadlineRow event={event} />

        {hasPrep && (
          <div className="mt-2.5">
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              aria-expanded={open}
              className="inline-flex items-center gap-1.5 rounded-md text-xs font-medium text-ink-secondary transition-colors hover:text-ink-primary"
            >
              <ChevronIcon open={open} />
              {open ? "Hide prep checklist" : "Prep checklist"}
              <span className="tabular text-ink-muted">({event.prep.length})</span>
            </button>

            {open && (
              <div className="mt-2 rounded-md border border-chartborder bg-page p-3">
                <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
                  Have this ready before the opportunity
                </div>
                <ul className="flex flex-col gap-1.5">
                  {event.prep.map((p, i) => (
                    <li key={i} className="flex items-start gap-2 text-xs leading-relaxed text-ink-secondary">
                      <CheckCircleIcon />
                      <span>{p}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function SummaryTile({
  label,
  event,
  kind,
}: {
  label: string;
  event: RadarEvent | undefined;
  kind: "start" | "deadline";
}) {
  const days = event ? (kind === "start" ? event.days_until_start : event.days_until_deadline) : null;
  const dateStr = event ? (kind === "start" ? event.start_date : event.submission_deadline) : null;
  return (
    <div className="rounded-card border border-chartborder bg-surface p-4">
      <div className="text-xs text-ink-muted">{label}</div>
      {event && dateStr && days !== null ? (
        <>
          <div className="mt-1 truncate text-base font-semibold text-ink-primary" title={event.name}>
            {event.name}
          </div>
          <div className="mt-1 flex items-center gap-2 text-xs text-ink-secondary">
            <span>{fmtLong(dateStr)}</span>
            <DaysChip days={days} />
          </div>
        </>
      ) : (
        <div className="mt-1 text-base font-semibold text-ink-muted">—</div>
      )}
    </div>
  );
}

// ---- grouping: "This month" / "Next 90 days" / "Later" ----------------------------------
const GROUP_ORDER = ["This month", "Next 90 days", "Later"] as const;
type GroupLabel = (typeof GROUP_ORDER)[number];

function bucketFor(event: RadarEvent, today: string): GroupLabel {
  const [ty, tm] = ymd(today);
  const [ey, em] = ymd(event.start_date);
  if (ey === ty && em === tm) return "This month";
  if (event.days_until_start <= 90) return "Next 90 days";
  return "Later";
}

export default function Radar() {
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const { data, isLoading, isError, error } = useRadar(typeFilter);

  const groups: Record<GroupLabel, RadarEvent[]> = {
    "This month": [],
    "Next 90 days": [],
    Later: [],
  };
  if (data) {
    // upcoming already arrives sorted nearest-first from the API.
    for (const e of data.upcoming) groups[bucketFor(e, data.today)].push(e);
  }

  const nextOpportunity = data?.upcoming[0];
  const nextDeadline = data?.upcoming
    .filter((e) => e.days_until_deadline !== null && e.days_until_deadline >= 0)
    .sort((a, b) => (a.days_until_deadline ?? 0) - (b.days_until_deadline ?? 0))[0];

  const isEmpty = data && data.upcoming.length === 0 && data.recent_past.length === 0;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-lg font-semibold text-ink-primary">Opportunity Radar</h1>
        <p className="mt-0.5 text-sm text-ink-muted">
          A curated calendar of indie-relevant Steam and marketing moments — Next Fests, seasonal sales,
          festivals, and awards — with a live "days until" and submission deadlines so you never miss a
          window. Recurring dates are best-guess approximations until organizers confirm them; check the note
          and official page before you build to one.
        </p>
      </div>

      {data && data.available_types.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-xs text-ink-muted">Filter</span>
          <TypeChip
            label="All"
            count={data.available_types.reduce((sum, t) => sum + t.count, 0)}
            active={typeFilter === null}
            onClick={() => setTypeFilter(null)}
          />
          {data.available_types.map((t) => (
            <TypeChip
              key={t.type}
              label={typeMeta(t.type).label}
              count={t.count}
              color={typeMeta(t.type).color}
              active={typeFilter === t.type}
              onClick={() => setTypeFilter(t.type)}
            />
          ))}
        </div>
      )}

      {isLoading && (
        <Card>
          <div className="py-6 text-sm text-ink-muted">Loading opportunities…</div>
        </Card>
      )}

      {isError && (
        <Card>
          <div className="py-6 text-sm text-status-serious">
            Failed to load the radar{error instanceof Error ? `: ${error.message}` : "."}
          </div>
        </Card>
      )}

      {isEmpty && (
        <Card>
          <EmptyState title="Nothing on the radar" description="No upcoming or recent opportunities in the curated calendar." />
        </Card>
      )}

      {data && !isEmpty && (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <SummaryTile label="Next opportunity" event={nextOpportunity} kind="start" />
            <SummaryTile label="Next submission deadline" event={nextDeadline} kind="deadline" />
          </div>

          {GROUP_ORDER.map((label) =>
            groups[label].length === 0 ? null : (
              <section key={label}>
                <div className="mb-2 flex items-baseline gap-2">
                  <h2 className="text-sm font-semibold text-ink-primary">{label}</h2>
                  <span className="tabular text-xs text-ink-muted">{groups[label].length}</span>
                </div>
                <div className="flex flex-col gap-2.5">
                  {groups[label].map((e) => (
                    <EventRow key={e.id} event={e} />
                  ))}
                </div>
              </section>
            ),
          )}

          {data.recent_past.length > 0 && (
            <section>
              <div className="mb-2 flex items-baseline gap-2">
                <h2 className="text-sm font-semibold text-ink-primary">Recently opened</h2>
                <span className="text-xs text-ink-muted">last 30 days</span>
              </div>
              <div className="flex flex-col gap-2.5">
                {data.recent_past.map((e) => (
                  <EventRow key={e.id} event={e} />
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
