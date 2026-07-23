import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import clsx from "clsx";

import {
  CreatorDrawer,
  PlatformBadge,
  STAGES,
  STAGE_META,
  StageBadge,
  useBoard,
  useCandidates,
  useMoveStage,
  useOutreachGenres,
  useUpsertTarget,
  q as buildQs,
  type CandidateRow,
  type SelectedCreator,
  type Stage,
  type TargetOut,
} from "../components/CreatorDrawer";
import { Card } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { request, type GameSearchList } from "../lib/api";
import { fmtCompact } from "../lib/format";

// A picked target game: narrows candidates to the game's primary genre and scopes the board.
interface TargetGame {
  appid: number;
  name: string;
  genre: string | null;
}

/** Typeahead over the game catalog — reuses the public /games/search endpoint. */
function useGameTypeahead(query: string) {
  return useQuery({
    queryKey: ["outreach-game-search", query],
    queryFn: () =>
      request<GameSearchList>(
        `/games/search${buildQs({ q: query, sort: "total_reviews", order: "desc", limit: 8, offset: 0 })}`,
      ),
    enabled: query.trim().length >= 2,
    placeholderData: keepPreviousData,
  });
}

function GameTargetPicker({ game, onPick, onClear }: { game: TargetGame | null; onPick: (g: TargetGame) => void; onClear: () => void }) {
  const [text, setText] = useState("");
  const [debounced, setDebounced] = useState("");
  const [focused, setFocused] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(text), 200);
    return () => window.clearTimeout(t);
  }, [text]);

  // Close the dropdown on outside click.
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setFocused(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const searchQ = useGameTypeahead(debounced);
  const open = focused && debounced.trim().length >= 2;

  if (game) {
    return (
      <span className="inline-flex items-center gap-2 rounded-md border border-brand bg-brand-tint px-2 py-1 text-xs text-brand">
        <span className="font-medium">Targeting: {game.name}</span>
        {game.genre && <span className="text-brand/70">· {game.genre}</span>}
        <button type="button" onClick={onClear} aria-label="Clear target game" className="text-brand hover:opacity-70">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </span>
    );
  }

  return (
    <div ref={boxRef} className="relative">
      <input
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onFocus={() => setFocused(true)}
        placeholder="Target a game… (search title)"
        className="w-56 rounded-md border border-chartborder bg-page px-2.5 py-1.5 text-xs text-ink-primary outline-none focus:border-brand"
      />
      {open && (
        <div className="absolute z-20 mt-1 w-72 overflow-hidden rounded-lg border border-chartborder bg-surface shadow-lg">
          {searchQ.isLoading && <div className="px-3 py-2 text-xs text-ink-muted">Searching…</div>}
          {searchQ.data && searchQ.data.items.length === 0 && (
            <div className="px-3 py-2 text-xs text-ink-muted">No games match “{debounced}”.</div>
          )}
          {searchQ.data &&
            searchQ.data.items.slice(0, 8).map((g) => (
              <button
                key={g.appid}
                type="button"
                onClick={() => {
                  onPick({ appid: g.appid, name: g.name ?? `App ${g.appid}`, genre: g.primary_genre });
                  setText("");
                  setFocused(false);
                }}
                className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs hover:bg-page"
              >
                <span className="min-w-0 truncate font-medium text-ink-primary">{g.name ?? `App ${g.appid}`}</span>
                <span className="shrink-0 text-[10px] text-ink-muted">{g.primary_genre ?? "—"}</span>
              </button>
            ))}
        </div>
      )}
    </div>
  );
}

function Selector({ value, options, onChange }: { value: string; options: string[]; onChange: (v: string) => void }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={options.length === 0}
      className="rounded-md border border-chartborder bg-page px-2 py-1.5 text-xs text-ink-primary outline-none focus:border-brand"
    >
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );
}

/** One ranked creator in the candidates rail. Click opens the drawer; the Add button is a
 * one-tap shortcut to drop them on the board at "to pitch" without opening the drawer. */
function CandidateItem({
  row,
  onOpen,
  onAdd,
  adding,
}: {
  row: CandidateRow;
  onOpen: () => void;
  onAdd: () => void;
  adding: boolean;
}) {
  const name = row.display_name ?? row.creator_handle;
  const topReason = row.fit.reasons[row.fit.reasons.length - 1];
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      className="cursor-pointer border-b border-chartborder/60 px-3 py-2.5 last:border-0 hover:bg-page"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-ink-primary">{name}</div>
          <div className="mt-1 flex items-center gap-2">
            <PlatformBadge platform={row.platform} />
            <span className="tabular text-[11px] text-ink-secondary">{row.reach != null ? `${fmtCompact(row.reach)} reach` : "no reach yet"}</span>
            <span className={clsx("text-[10px]", row.n_mentions_recent >= 1 ? "text-status-good" : "text-ink-muted")}>
              {row.n_mentions_recent >= 1 ? "active" : "quiet"}
            </span>
          </div>
        </div>
        <div className="shrink-0">
          {row.stage ? (
            <StageBadge stage={row.stage} />
          ) : (
            <button
              type="button"
              disabled={adding}
              onClick={(e) => {
                e.stopPropagation();
                onAdd();
              }}
              className="rounded-md border border-chartborder px-2 py-1 text-[11px] font-medium text-ink-secondary hover:border-brand hover:text-brand disabled:opacity-50"
            >
              {adding ? "…" : "+ Add"}
            </button>
          )}
        </div>
      </div>
      {topReason && <div className="mt-1.5 truncate text-[11px] text-ink-muted">{topReason}</div>}
    </div>
  );
}

function BoardCard({
  target,
  onOpen,
  onDragStart,
}: {
  target: TargetOut;
  onOpen: () => void;
  onDragStart: (e: React.DragEvent) => void;
}) {
  const name = target.display_name ?? target.creator_handle;
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onClick={onOpen}
      className="cursor-pointer rounded-lg border border-chartborder bg-surface p-2.5 shadow-sm hover:border-ink-muted"
    >
      <div className="truncate text-xs font-medium text-ink-primary">{name}</div>
      <div className="mt-1.5 flex items-center justify-between gap-2">
        <PlatformBadge platform={target.platform} />
        <span className="tabular text-[10px] text-ink-muted">{target.reach != null ? fmtCompact(target.reach) : "—"}</span>
      </div>
      <div className="mt-1.5 flex items-center gap-2 text-[10px] text-ink-muted">
        {target.appid != null && <span className="rounded bg-surface2 px-1 py-0.5">game</span>}
        {target.genre && <span className="truncate">{target.genre}</span>}
        {target.note_count > 0 && <span className="ml-auto shrink-0">{target.note_count} note{target.note_count === 1 ? "" : "s"}</span>}
      </div>
    </div>
  );
}

/**
 * Outreach — a per-game / per-genre PITCH PIPELINE workbench. Pick a genre (or target a specific
 * game); the left rail ranks creators who cover it with a fit-explained "why"; the right is a
 * six-stage kanban of the creators you're working. Drag cards between stages, or click any
 * creator / card to open the drawer (fit breakdown, pitch draft, stage controls, notes).
 */
export default function Outreach() {
  const genresQ = useOutreachGenres();
  const [genre, setGenre] = useState<string | null>(null);
  const [game, setGame] = useState<TargetGame | null>(null);
  const [statusFilter, setStatusFilter] = useState<Stage | "all">("all");

  // Drawer selection + its scope (may differ from the page scope when opening a board card).
  const [selected, setSelected] = useState<SelectedCreator | null>(null);
  const [selScope, setSelScope] = useState<{ appid: number | null; genre: string | null; gameName: string | null }>({
    appid: null,
    genre: null,
    gameName: null,
  });

  const [searchParams] = useSearchParams();
  useEffect(() => {
    if (genre !== null) return;
    const list = genresQ.data;
    if (!list?.length) return;
    // Honour a ?genre= deep-link (e.g. from Marketing's "prioritise creator outreach"), else first.
    const wanted = searchParams.get("genre");
    setGenre(wanted && list.includes(wanted) ? wanted : list[0]);
  }, [genresQ.data, genre, searchParams]);

  const appidScope = game?.appid ?? null;
  // When a game is targeted, the backend resolves genre from its appid — don't also send genre.
  const candidatesQ = useCandidates(game ? null : genre, appidScope, statusFilter);
  const boardQ = useBoard(appidScope);
  const upsert = useUpsertTarget();
  const move = useMoveStage();

  const [addingKey, setAddingKey] = useState<string | null>(null);
  const [dragOverStage, setDragOverStage] = useState<Stage | null>(null);

  const resolvedGenre = candidatesQ.data?.genre ?? genre;
  const candidates = candidatesQ.data?.items ?? [];
  const boardStages = boardQ.data?.stages ?? [];
  const boardTotal = boardStages.reduce((n, s) => n + s.targets.length, 0);

  function openCandidate(c: CandidateRow) {
    setSelected({
      platform: c.platform,
      handle: c.creator_handle,
      display_name: c.display_name,
      fit: c.fit,
      targetId: c.target_id,
    });
    setSelScope({ appid: appidScope, genre: resolvedGenre, gameName: game?.name ?? null });
  }

  function openCard(t: TargetOut) {
    setSelected({
      platform: t.platform,
      handle: t.creator_handle,
      display_name: t.display_name,
      fit: null,
      targetId: t.id,
    });
    setSelScope({ appid: t.appid, genre: t.genre, gameName: t.appid === appidScope ? game?.name ?? null : null });
  }

  function quickAdd(c: CandidateRow) {
    const key = `${c.platform}:${c.creator_handle}`;
    setAddingKey(key);
    upsert.mutate(
      {
        platform: c.platform,
        creator_handle: c.creator_handle,
        display_name: c.display_name,
        genre: resolvedGenre,
        appid: appidScope,
        reach: c.reach,
        stage: "to_pitch",
      },
      { onSettled: () => setAddingKey(null) },
    );
  }

  function onDrop(stage: Stage, e: React.DragEvent) {
    e.preventDefault();
    setDragOverStage(null);
    const id = Number(e.dataTransfer.getData("text/plain"));
    if (!id) return;
    const card = boardStages.flatMap((s) => s.targets).find((t) => t.id === id);
    if (card && card.stage !== stage) move.mutate({ target_id: id, stage });
  }

  const genreOptions = genresQ.data ?? [];
  const boardLabel = game ? `Board — ${game.name}` : "Board — all outreach";

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold text-ink-primary">Outreach</h1>
        <p className="mt-0.5 text-sm text-ink-muted">
          Your pitch pipeline. Pick a genre — or target a specific game — to rank the YouTube and Twitch creators who
          cover it, then work them through a six-stage board from “to pitch” to “covered”.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-xs text-ink-muted">
          Genre
          <Selector value={game ? game.genre ?? "" : genre ?? ""} options={genreOptions} onChange={(v) => { setGame(null); setGenre(v); }} />
        </label>
        <GameTargetPicker
          game={game}
          onPick={(g) => setGame(g)}
          onClear={() => setGame(null)}
        />
      </div>

      {genresQ.isError && (
        <Card>
          <div className="text-sm text-status-critical">
            Failed to load genres{genresQ.error instanceof Error ? `: ${genresQ.error.message}` : "."}
          </div>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[340px_1fr]">
        {/* Candidates rail */}
        <Card className="!p-0">
          <div className="flex items-center justify-between gap-2 border-b border-chartborder px-3 py-2.5">
            <div>
              <h3 className="text-sm font-semibold text-ink-primary">Candidates</h3>
              <p className="text-[11px] text-ink-muted">
                {resolvedGenre ? `Ranked for ${resolvedGenre}` : "Pick a genre"}
                {candidates.length > 0 ? ` · ${candidates.length}` : ""}
              </p>
            </div>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as Stage | "all")}
              className="rounded-md border border-chartborder bg-page px-1.5 py-1 text-[11px] text-ink-primary outline-none focus:border-brand"
            >
              <option value="all">All</option>
              {STAGES.map((s) => (
                <option key={s} value={s}>
                  {STAGE_META[s].label}
                </option>
              ))}
            </select>
          </div>

          <div className="max-h-[70vh] overflow-y-auto">
            {candidatesQ.isLoading && <div className="p-4 text-xs text-ink-muted">Loading creators…</div>}
            {candidatesQ.isError && (
              <div className="p-4 text-xs text-status-critical">
                Failed to load candidates{candidatesQ.error instanceof Error ? `: ${candidatesQ.error.message}` : "."}
              </div>
            )}
            {candidatesQ.data && candidates.length === 0 && (
              <div className="p-4 text-xs text-ink-muted">
                {statusFilter === "all"
                  ? `No creators found for ${resolvedGenre ?? "this genre"} yet. Creator coverage comes from the YouTube/Twitch scrapers.`
                  : `No candidates at “${STAGE_META[statusFilter].label}”.`}
              </div>
            )}
            {candidates.map((c) => (
              <CandidateItem
                key={`${c.platform}:${c.creator_handle}`}
                row={c}
                onOpen={() => openCandidate(c)}
                onAdd={() => quickAdd(c)}
                adding={addingKey === `${c.platform}:${c.creator_handle}`}
              />
            ))}
          </div>
        </Card>

        {/* Kanban board */}
        <Card className="!p-0">
          <div className="flex items-center justify-between gap-2 border-b border-chartborder px-3 py-2.5">
            <div>
              <h3 className="text-sm font-semibold text-ink-primary">{boardLabel}</h3>
              <p className="text-[11px] text-ink-muted">Drag cards between stages, or click one to open it</p>
            </div>
            <span className="tabular text-[11px] text-ink-muted">{boardTotal} tracked</span>
          </div>

          {boardQ.isLoading && <div className="p-4 text-xs text-ink-muted">Loading board…</div>}
          {boardQ.data && boardTotal === 0 && (
            <EmptyState
              title="No creators on the board yet"
              description="Add creators from the candidates rail — hover a row and hit “+ Add”, or open one and choose a stage."
            />
          )}
          {boardQ.data && boardTotal > 0 && (
            <div className="overflow-x-auto p-3">
              <div className="flex gap-3" style={{ minWidth: "min-content" }}>
                {boardStages.map((grp) => {
                  const meta = STAGE_META[grp.stage];
                  return (
                    <div
                      key={grp.stage}
                      onDragOver={(e) => {
                        e.preventDefault();
                        setDragOverStage(grp.stage);
                      }}
                      onDragLeave={() => setDragOverStage((s) => (s === grp.stage ? null : s))}
                      onDrop={(e) => onDrop(grp.stage, e)}
                      className={clsx(
                        "flex w-56 shrink-0 flex-col rounded-lg border bg-page transition-colors",
                        dragOverStage === grp.stage ? "border-brand bg-brand-tint" : "border-chartborder",
                      )}
                    >
                      <div className="flex items-center justify-between gap-2 border-b border-chartborder px-2.5 py-2">
                        <div className="flex items-center gap-1.5">
                          <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: meta.dot }} />
                          <span className="text-[11px] font-semibold text-ink-primary">{grp.label}</span>
                        </div>
                        <span className="tabular text-[10px] text-ink-muted">{grp.targets.length}</span>
                      </div>
                      <div className="flex min-h-[80px] flex-col gap-2 p-2">
                        {grp.targets.map((t) => (
                          <BoardCard
                            key={t.id}
                            target={t}
                            onOpen={() => openCard(t)}
                            onDragStart={(e) => e.dataTransfer.setData("text/plain", String(t.id))}
                          />
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </Card>
      </div>

      <CreatorDrawer
        open={selected !== null}
        onClose={() => setSelected(null)}
        selected={selected}
        appidScope={selScope.appid}
        genre={selScope.genre}
        gameName={selScope.gameName}
      />
    </div>
  );
}
