import { useEffect, useMemo, useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";

import { Drawer } from "./ui/Drawer";
import { request } from "../lib/api";
import { fmtCompact, fmtInt } from "../lib/format";

// This module is the shared client for the Outreach workbench: the API types, the React Query
// hooks, AND the CreatorDrawer slide-over. It lives here (the leaf component file) rather than
// in Outreach.tsx so the page can import the hooks/types without a circular import — the page
// imports this file, this file imports nothing from the page. lib/api.ts is owned by another
// track, so its `request` helper is reused as-is and the outreach hooks live here.

// ---- query-string helper (lib/api's own `qs` is module-private) -------------------------
export function q(params: Record<string, string | number | null | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

// ---- types (mirror api/app/routers/outreach.py) -----------------------------------------
export type Stage = "to_pitch" | "queued" | "pitched" | "replied" | "covered" | "declined";

export const STAGES: Stage[] = ["to_pitch", "queued", "pitched", "replied", "covered", "declined"];

export const STAGE_META: Record<Stage, { label: string; dot: string; text: string }> = {
  to_pitch: { label: "To pitch", dot: "#94a3b8", text: "text-ink-secondary" },
  queued: { label: "Queued", dot: "#3b82f6", text: "text-ink-secondary" },
  pitched: { label: "Pitched", dot: "#f59e0b", text: "text-status-warning" },
  replied: { label: "Replied", dot: "#8b5cf6", text: "text-ink-secondary" },
  covered: { label: "Covered", dot: "#10b981", text: "text-status-good" },
  declined: { label: "Declined", dot: "#6b7280", text: "text-ink-muted" },
};

export const PLATFORM_COLOR: Record<string, string> = {
  youtube: "#ef4444",
  twitch: "#8b5cf6",
  reddit: "#ff4500",
  x: "#1d1d1f",
};

export interface Fit {
  reach: number | null;
  recent_activity: number;
  games_covered: number;
  reasons: string[];
}

export interface CandidateRow {
  platform: string;
  creator_id: number;
  creator_handle: string;
  display_name: string | null;
  creator_url: string | null;
  reach: number | null;
  reach_captured_at: string | null;
  n_mentions: number;
  n_mentions_recent: number;
  n_games_covered: number;
  pitch_score: number | null;
  example_title: string | null;
  example_url: string | null;
  example_published_at: string | null;
  stage: Stage | null;
  target_id: number | null;
  fit: Fit;
}

export interface CandidatesResponse {
  genre: string;
  appid: number | null;
  game_name: string | null;
  items: CandidateRow[];
}

export interface TargetOut {
  id: number;
  appid: number | null;
  platform: string;
  creator_handle: string;
  display_name: string | null;
  genre: string | null;
  stage: Stage;
  reach: number | null;
  contacted_at: string | null;
  replied_at: string | null;
  updated_at: string | null;
  note_count: number;
}

export interface StageGroup {
  stage: Stage;
  label: string;
  targets: TargetOut[];
}

export interface BoardResponse {
  appid: number | null;
  stages: StageGroup[];
}

export interface TargetIn {
  platform: string;
  creator_handle: string;
  display_name?: string | null;
  genre?: string | null;
  appid?: number | null;
  reach?: number | null;
  stage?: Stage;
}

export interface CreatorGenreRow {
  genre: string;
  n_mentions: number;
  n_mentions_recent: number;
  n_games_covered: number;
  pitch_score: number | null;
  example_title: string | null;
  example_url: string | null;
  example_published_at: string | null;
}

export interface CreatorDetail {
  platform: string;
  handle: string;
  display_name: string | null;
  creator_url: string | null;
  reach: number | null;
  reach_captured_at: string | null;
  coverage: CreatorGenreRow[];
}

export interface PitchTemplate {
  subject: string;
  body: string;
}

export interface NoteOut {
  id: number;
  target_id: number;
  body: string;
  created_at: string | null;
}

/** DuckDB/ISO timestamp -> "2026-07-18". */
export function dateOnly(s: string | null): string {
  return s ? s.slice(0, 10) : "—";
}

// ---- hooks ------------------------------------------------------------------------------
export function useOutreachGenres() {
  return useQuery({
    queryKey: ["outreach-genres"],
    queryFn: () => request<string[]>("/outreach/genres"),
    staleTime: 5 * 60_000,
  });
}

export function useCandidates(genre: string | null, appid: number | null, status: Stage | "all", limit = 50) {
  return useQuery({
    queryKey: ["outreach-candidates", genre, appid, status, limit],
    queryFn: () =>
      request<CandidatesResponse>(
        `/outreach/candidates${q({ genre, appid, status: status === "all" ? undefined : status, limit })}`,
      ),
    enabled: appid !== null || (genre !== null && genre !== ""),
    placeholderData: keepPreviousData,
  });
}

export function useBoard(appid: number | null) {
  return useQuery({
    queryKey: ["outreach-board", appid],
    queryFn: () => request<BoardResponse>(`/outreach/board${q({ appid })}`),
    placeholderData: keepPreviousData,
  });
}

export function useUpsertTarget() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: TargetIn) =>
      request<TargetOut>("/outreach/target", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["outreach-board"] });
      qc.invalidateQueries({ queryKey: ["outreach-candidates"] });
    },
  });
}

export function useMoveStage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { target_id: number; stage: Stage }) =>
      request<TargetOut>("/outreach/stage", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["outreach-board"] });
      qc.invalidateQueries({ queryKey: ["outreach-candidates"] });
    },
  });
}

export function useCreatorDetail(platform: string | null, handle: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["outreach-creator", platform, handle],
    queryFn: () => request<CreatorDetail>(`/outreach/creator${q({ platform, handle })}`),
    enabled: enabled && !!platform && !!handle,
    staleTime: 5 * 60_000,
  });
}

export function usePitchTemplate(platform: string | null, handle: string | null, appid: number | null, enabled: boolean) {
  return useQuery({
    queryKey: ["outreach-template", platform, handle, appid],
    queryFn: () => request<PitchTemplate>(`/outreach/template${q({ platform, handle, appid })}`),
    enabled: enabled && !!platform && !!handle,
    staleTime: 5 * 60_000,
  });
}

export function useNotes(targetId: number | null) {
  return useQuery({
    queryKey: ["outreach-notes", targetId],
    queryFn: () => request<NoteOut[]>(`/outreach/notes${q({ target_id: targetId })}`),
    enabled: targetId !== null,
  });
}

export function useAddNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { target_id: number; body: string }) =>
      request<NoteOut>("/outreach/note", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["outreach-notes", vars.target_id] });
      qc.invalidateQueries({ queryKey: ["outreach-board"] });
    },
  });
}

// ---- selection contract shared with the page --------------------------------------------
export interface SelectedCreator {
  platform: string;
  handle: string;
  display_name: string | null;
  fit: Fit | null;
  targetId: number | null;
}

// ---- small presentational bits ----------------------------------------------------------
export function PlatformBadge({ platform }: { platform: string }) {
  const color = PLATFORM_COLOR[platform] ?? "var(--text-muted)";
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md bg-surface2 px-1.5 py-0.5 text-[11px] font-medium text-ink-secondary">
      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
      {platform}
    </span>
  );
}

export function StageBadge({ stage }: { stage: Stage }) {
  const meta = STAGE_META[stage];
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-chartborder bg-page px-2 py-0.5 text-[11px] text-ink-secondary">
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: meta.dot }} />
      {meta.label}
    </span>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-chartborder bg-page p-2.5">
      <div className="text-[10px] uppercase tracking-wide text-ink-muted">{label}</div>
      <div className="tabular mt-0.5 text-base font-semibold text-ink-primary">{value}</div>
      {sub && <div className="text-[10px] text-ink-muted">{sub}</div>}
    </div>
  );
}

function StageControl({
  current,
  disabled,
  onMove,
}: {
  current: Stage | null;
  disabled: boolean;
  onMove: (stage: Stage) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {STAGES.map((s) => {
        const active = current === s;
        const meta = STAGE_META[s];
        return (
          <button
            key={s}
            type="button"
            disabled={disabled || active}
            onClick={() => onMove(s)}
            className={clsx(
              "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors disabled:cursor-default",
              active
                ? "border-brand bg-brand-tint text-brand"
                : "border-chartborder text-ink-muted hover:border-ink-muted hover:text-ink-primary disabled:opacity-50",
            )}
          >
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: meta.dot }} />
            {meta.label}
          </button>
        );
      })}
    </div>
  );
}

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

/**
 * CreatorDrawer — the outreach workbench slide-over. Shows one creator: audience stats, the fit
 * breakdown (why they rank), which genres/games they cover, a pre-filled pitch email (copy),
 * pipeline stage controls, and per-target notes. Opened from either a candidate row or a board
 * card. Stage moves / notes require the creator to be on the board — an "Add to board" affordance
 * appears when they aren't yet, and once added the drawer switches to the tracked view in place.
 */
export function CreatorDrawer({
  open,
  onClose,
  selected,
  appidScope,
  genre,
  gameName,
}: {
  open: boolean;
  onClose: () => void;
  selected: SelectedCreator | null;
  appidScope: number | null;
  genre: string | null;
  gameName: string | null;
}) {
  const platform = selected?.platform ?? null;
  const handle = selected?.handle ?? null;

  const detailQ = useCreatorDetail(platform, handle, open);
  const templateQ = usePitchTemplate(platform, handle, appidScope, open);
  const boardQ = useBoard(appidScope);
  const upsert = useUpsertTarget();
  const move = useMoveStage();
  const addNote = useAddNote();

  // Local tracking id: seeded from the candidate's target_id, updated when we add-to-board here,
  // so the drawer flips to the tracked view without waiting for the parent to re-derive selection.
  const [localTargetId, setLocalTargetId] = useState<number | null>(selected?.targetId ?? null);
  const [addStage, setAddStage] = useState<Stage>("to_pitch");
  const [noteDraft, setNoteDraft] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setLocalTargetId(selected?.targetId ?? null);
    setNoteDraft("");
    setCopied(false);
    setAddStage("to_pitch");
  }, [selected]);

  const liveTarget = useMemo(() => {
    const id = localTargetId;
    if (id === null) return null;
    for (const grp of boardQ.data?.stages ?? []) {
      const hit = grp.targets.find((t) => t.id === id);
      if (hit) return hit;
    }
    return null;
  }, [boardQ.data, localTargetId]);

  const detail = detailQ.data;
  const reach = detail?.reach ?? selected?.fit?.reach ?? null;
  const recent = selected?.fit?.recent_activity ?? 0;
  const games = selected?.fit?.games_covered ?? 0;
  const currentStage: Stage | null = liveTarget?.stage ?? null;
  const isTracked = localTargetId !== null;
  const busy = upsert.isPending || move.isPending;

  function handleAdd() {
    if (!selected) return;
    upsert.mutate(
      {
        platform: selected.platform,
        creator_handle: selected.handle,
        display_name: selected.display_name,
        genre,
        appid: appidScope,
        reach,
        stage: addStage,
      },
      { onSuccess: (t) => setLocalTargetId(t.id) },
    );
  }

  function handleMove(stage: Stage) {
    if (localTargetId === null) return;
    move.mutate({ target_id: localTargetId, stage });
  }

  function handleCopy() {
    if (!templateQ.data) return;
    const text = `Subject: ${templateQ.data.subject}\n\n${templateQ.data.body}`;
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    });
  }

  function submitNote() {
    const body = noteDraft.trim();
    if (!body || localTargetId === null) return;
    addNote.mutate({ target_id: localTargetId, body }, { onSuccess: () => setNoteDraft("") });
  }

  const notesQ = useNotes(localTargetId);

  const title = selected?.display_name ?? selected?.handle ?? "Creator";
  const subtitle = selected ? `${selected.platform}${reach != null ? ` · ${fmtCompact(reach)} reach` : ""}` : undefined;

  return (
    <Drawer open={open} onClose={onClose} title={title} subtitle={subtitle}>
      {!selected ? null : (
        <div className="flex flex-col gap-6 pb-8">
          {/* audience stats */}
          <div className="grid grid-cols-3 gap-2.5">
            <Stat
              label="Reach"
              value={reach != null ? fmtCompact(reach) : "—"}
              sub={detail?.reach_captured_at ? `as of ${dateOnly(detail.reach_captured_at)}` : "no snapshot yet"}
            />
            <Stat label="Recent activity" value={fmtInt(recent)} sub={recent >= 1 ? "active" : "quiet"} />
            <Stat label="Games covered" value={fmtInt(games)} sub={genre ?? undefined} />
          </div>

          {/* pipeline stage */}
          <Section title="Pipeline">
            {isTracked ? (
              <div className="flex flex-col gap-3 rounded-lg border border-chartborder bg-page p-3">
                <StageControl current={currentStage} disabled={busy} onMove={handleMove} />
                <div className="flex flex-wrap gap-x-5 gap-y-1 text-[11px] text-ink-muted">
                  <span>Contacted: {liveTarget?.contacted_at ? dateOnly(liveTarget.contacted_at) : "—"}</span>
                  <span>Replied: {liveTarget?.replied_at ? dateOnly(liveTarget.replied_at) : "—"}</span>
                  {liveTarget?.appid != null && <span>Game-scoped (appid {liveTarget.appid})</span>}
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2 rounded-lg border border-chartborder bg-page p-3">
                <span className="text-xs text-ink-muted">Not on your board.</span>
                <select
                  value={addStage}
                  onChange={(e) => setAddStage(e.target.value as Stage)}
                  className="rounded-md border border-chartborder bg-surface px-2 py-1 text-xs text-ink-primary outline-none focus:border-brand"
                >
                  {STAGES.map((s) => (
                    <option key={s} value={s}>
                      {STAGE_META[s].label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  disabled={busy}
                  onClick={handleAdd}
                  className="rounded-md bg-brand px-3 py-1 text-xs font-medium text-brand-fg hover:bg-brand-hover disabled:opacity-50"
                >
                  {upsert.isPending ? "Adding…" : "Add to board"}
                </button>
              </div>
            )}
          </Section>

          {/* fit breakdown */}
          {selected.fit && selected.fit.reasons.length > 0 && (
            <Section title="Why this creator">
              <ul className="flex flex-col gap-1.5 rounded-lg border border-chartborder bg-page p-3 text-xs text-ink-secondary">
                {selected.fit.reasons.map((r, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="shrink-0 text-brand">·</span>
                    <span>{r}</span>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {/* pitch template */}
          <Section
            title="Pitch draft"
            action={
              <button
                type="button"
                disabled={!templateQ.data}
                onClick={handleCopy}
                className="rounded-md border border-chartborder px-2.5 py-1 text-[11px] font-medium text-ink-secondary hover:text-ink-primary disabled:opacity-50"
              >
                {copied ? "Copied" : "Copy"}
              </button>
            }
          >
            {templateQ.isLoading && <div className="text-xs text-ink-muted">Building draft…</div>}
            {templateQ.data && (
              <div className="rounded-lg border border-chartborder bg-page p-3">
                <div className="mb-2 text-xs font-medium text-ink-primary">Subject: {templateQ.data.subject}</div>
                <pre className="whitespace-pre-wrap font-sans text-xs leading-relaxed text-ink-secondary">
                  {templateQ.data.body}
                </pre>
              </div>
            )}
          </Section>

          {/* coverage */}
          <Section title="What they cover">
            {detailQ.isLoading && <div className="text-xs text-ink-muted">Loading coverage…</div>}
            {detailQ.isError && <div className="text-xs text-status-critical">Could not load creator detail.</div>}
            {detail && detail.coverage.length > 0 && (
              <div className="overflow-x-auto rounded-lg border border-chartborder">
                <table className="w-full min-w-[440px] text-xs">
                  <thead>
                    <tr className="border-b border-chartborder text-left text-ink-muted">
                      <th className="px-2 py-1.5 font-medium">Genre</th>
                      <th className="px-2 py-1.5 font-medium">Games</th>
                      <th className="px-2 py-1.5 font-medium">Recent</th>
                      <th className="px-2 py-1.5 font-medium">Example</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.coverage.map((c) => (
                      <tr key={c.genre} className="border-b border-chartborder/60 last:border-0 align-top">
                        <td className="px-2 py-1.5 font-medium text-ink-primary">{c.genre}</td>
                        <td className="tabular px-2 py-1.5 text-ink-secondary">{fmtInt(c.n_games_covered)}</td>
                        <td className="tabular px-2 py-1.5 text-ink-secondary">{fmtInt(c.n_mentions_recent)}</td>
                        <td className="max-w-[220px] px-2 py-1.5">
                          {c.example_title ? (
                            c.example_url ? (
                              <a
                                href={c.example_url}
                                target="_blank"
                                rel="noreferrer"
                                className="text-ink-secondary hover:text-brand hover:underline"
                              >
                                {c.example_title}
                              </a>
                            ) : (
                              <span className="text-ink-secondary">{c.example_title}</span>
                            )
                          ) : (
                            <span className="text-ink-muted">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>

          {/* notes */}
          <Section title="Notes">
            {!isTracked ? (
              <div className="rounded-lg border border-dashed border-chartborder bg-page p-3 text-xs text-ink-muted">
                Add this creator to your board to start taking notes.
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={noteDraft}
                    onChange={(e) => setNoteDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") submitNote();
                    }}
                    placeholder="Log a touchpoint… (e.g. sent DM, follow-up scheduled)"
                    className="flex-1 rounded-md border border-chartborder bg-page px-2.5 py-1.5 text-xs text-ink-primary outline-none focus:border-brand"
                  />
                  <button
                    type="button"
                    disabled={addNote.isPending || noteDraft.trim() === ""}
                    onClick={submitNote}
                    className="rounded-md border border-chartborder px-3 py-1.5 text-xs font-medium text-ink-secondary hover:text-ink-primary disabled:opacity-50"
                  >
                    Add
                  </button>
                </div>
                {notesQ.data && notesQ.data.length === 0 && (
                  <div className="text-xs text-ink-muted">No notes yet.</div>
                )}
                {notesQ.data && notesQ.data.length > 0 && (
                  <ul className="flex flex-col gap-2">
                    {notesQ.data
                      .slice()
                      .reverse()
                      .map((n) => (
                        <li key={n.id} className="rounded-lg border border-chartborder bg-page p-2.5">
                          <div className="text-xs text-ink-primary">{n.body}</div>
                          <div className="mt-1 text-[10px] text-ink-muted">{dateOnly(n.created_at)}</div>
                        </li>
                      ))}
                  </ul>
                )}
              </div>
            )}
          </Section>
        </div>
      )}
    </Drawer>
  );
}
