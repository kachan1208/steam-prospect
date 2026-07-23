import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { Card } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { request, useGenres, type GameSearchList, type GameSearchRow } from "../lib/api";
import { fmtCompact, fmtPct } from "../lib/format";

// ---- types (mirror api/app/routers/projects.py) -----------------------------------------
interface Project {
  id: number;
  appid: number | null;
  name: string;
  genre: string | null;
  stage: string;
  is_active: boolean;
  created_at: string;
  comps_count: number;
  header_image: string | null;
  steam_name: string | null;
  steam_genre: string | null;
  live_players: number | null;
  total_reviews: number | null;
  positive_ratio: number | null;
}

interface Comp {
  id: number;
  appid: number;
  name: string | null;
  header_image: string | null;
  primary_genre: string | null;
  total_reviews: number | null;
  positive_ratio: number | null;
  live_players: number | null;
}

type ProjectBody = { name: string; stage: string; genre: string | null; appid: number | null };
type ProjectPatch = Partial<ProjectBody> & { is_active?: boolean };

// The lifecycle stages — mirrors project_models.STAGES.
const STAGES = ["prototype", "production", "announced", "demo", "launched"] as const;
const STAGE_LABEL: Record<string, string> = {
  prototype: "Prototype",
  production: "In production",
  announced: "Announced",
  demo: "Demo out",
  launched: "Launched",
};

// ---- hooks ------------------------------------------------------------------------------
function useProjects() {
  return useQuery({ queryKey: ["projects"], queryFn: () => request<Project[]>("/projects") });
}

function invalidateProjects(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ["projects"] });
  qc.invalidateQueries({ queryKey: ["active-project"] });
}

function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ProjectBody) =>
      request<Project>("/projects", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => invalidateProjects(qc),
  });
}

function useUpdateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: number; body: ProjectPatch }) =>
      request<Project>(`/projects/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: () => invalidateProjects(qc),
  });
}

function useDeleteProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => request<void>(`/projects/${id}`, { method: "DELETE" }),
    onSuccess: () => invalidateProjects(qc),
  });
}

function useComps(projectId: number | null) {
  return useQuery({
    queryKey: ["comps", projectId],
    queryFn: () => request<Comp[]>(`/projects/${projectId}/comps`),
    enabled: projectId !== null,
  });
}

function useAddComp(projectId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (appid: number) =>
      request<Comp>(`/projects/${projectId}/comps`, { method: "POST", body: JSON.stringify({ appid }) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["comps", projectId] });
      invalidateProjects(qc); // comps_count changed
    },
  });
}

function useRemoveComp(projectId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (appid: number) =>
      request<void>(`/projects/${projectId}/comps/${appid}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["comps", projectId] });
      invalidateProjects(qc);
    },
  });
}

// ---- shared styles ----------------------------------------------------------------------
const INPUT_CLS =
  "w-full rounded-lg border border-chartborder bg-page px-3 py-2 text-sm text-ink-primary outline-none focus:border-brand";
const BTN_PRIMARY =
  "rounded-lg bg-brand px-3.5 py-2 text-sm font-semibold text-brand-fg transition-colors hover:bg-brand-hover disabled:opacity-50";
const BTN_GHOST =
  "rounded-lg border border-chartborder bg-surface px-3 py-2 text-sm font-medium text-ink-secondary transition-colors hover:bg-surface2 hover:text-ink-primary disabled:opacity-50";

// ---- game search picker (reuses GET /api/games/search) ----------------------------------
function useGameSearchLite(q: string) {
  return useQuery({
    queryKey: ["project-game-search", q],
    queryFn: () => request<GameSearchList>(`/games/search?q=${encodeURIComponent(q)}&limit=8`),
    enabled: q.trim().length >= 2,
    placeholderData: keepPreviousData,
  });
}

function GamePicker({
  onPick,
  placeholder,
}: {
  onPick: (g: GameSearchRow) => void;
  placeholder?: string;
}) {
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 250);
    return () => clearTimeout(t);
  }, [q]);

  const { data, isFetching } = useGameSearchLite(debounced);
  const results = data?.items ?? [];
  const show = open && debounced.trim().length >= 2;

  return (
    <div className="relative">
      <input
        type="text"
        value={q}
        placeholder={placeholder ?? "Search Steam games…"}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 150)}
        className={INPUT_CLS}
      />
      {show && (
        <div className="absolute z-20 mt-1 max-h-72 w-full overflow-y-auto rounded-lg border border-chartborder bg-surface shadow-md">
          {results.length === 0 && (
            <div className="px-3 py-2.5 text-sm text-ink-muted">
              {isFetching ? "Searching…" : "No games found."}
            </div>
          )}
          {results.map((g) => (
            <button
              key={g.appid}
              type="button"
              // onMouseDown (not onClick) so it fires before the input's onBlur closes the list.
              onMouseDown={(e) => {
                e.preventDefault();
                onPick(g);
                setQ("");
                setDebounced("");
                setOpen(false);
              }}
              className="flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-surface2"
            >
              {g.header_image && (
                <img src={g.header_image} alt="" loading="lazy" className="h-8 w-14 shrink-0 rounded-sm object-cover" />
              )}
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-ink-primary">{g.name ?? `App ${g.appid}`}</span>
                <span className="block truncate text-[11px] text-ink-muted">
                  {g.primary_genre ?? "—"}
                  {g.total_reviews != null ? ` · ${fmtCompact(g.total_reviews)} reviews` : ""}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- project form (create + edit) -------------------------------------------------------
function ProjectFormCard({
  project,
  onCreated,
  onCancel,
  canCancel,
}: {
  project?: Project;
  onCreated?: (p: Project) => void;
  onCancel?: () => void;
  canCancel?: boolean;
}) {
  const isEdit = !!project;
  const create = useCreateProject();
  const update = useUpdateProject();
  const genres = useGenres();

  const [name, setName] = useState(project?.name ?? "");
  const [stage, setStage] = useState<string>(project?.stage ?? "production");
  const [genre, setGenre] = useState(project?.genre ?? "");
  const [appid, setAppid] = useState<number | null>(project?.appid ?? null);
  const [linked, setLinked] = useState<{ name: string | null; header_image: string | null } | null>(
    project?.appid ? { name: project.steam_name, header_image: project.header_image } : null,
  );
  const [savedTick, setSavedTick] = useState(false);

  const pending = create.isPending || update.isPending;
  const mutErr = (create.error ?? update.error) as Error | null;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    const body: ProjectBody = { name: trimmed, stage, genre: genre.trim() || null, appid };
    if (isEdit && project) {
      update.mutate(
        { id: project.id, body },
        {
          onSuccess: () => {
            setSavedTick(true);
            window.setTimeout(() => setSavedTick(false), 1800);
          },
        },
      );
    } else {
      create.mutate(body, { onSuccess: (p) => onCreated?.(p) });
    }
  }

  return (
    <Card
      title={isEdit ? "Your game" : "Create your game"}
      subtitle={
        isEdit
          ? "The spine of your watchtower — its stage drives what the dashboard surfaces."
          : "Name it, set its stage, and (optionally) link its Steam page. You can add competitors once it's saved."
      }
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-xs font-medium text-ink-secondary">
            Name
            <input
              type="text"
              value={name}
              placeholder="e.g. Deep Delve"
              onChange={(e) => setName(e.target.value)}
              className={INPUT_CLS}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-ink-secondary">
            Stage
            <select value={stage} onChange={(e) => setStage(e.target.value)} className={INPUT_CLS}>
              {STAGES.map((s) => (
                <option key={s} value={s}>
                  {STAGE_LABEL[s]}
                </option>
              ))}
            </select>
          </label>
        </div>

        <label className="flex flex-col gap-1 text-xs font-medium text-ink-secondary">
          Genre
          <input
            list="project-genres"
            value={genre}
            placeholder="Pick a genre or type your own"
            onChange={(e) => setGenre(e.target.value)}
            className={INPUT_CLS}
          />
          <datalist id="project-genres">
            {genres
              .filter((g) => g.value !== "__all__")
              .map((g) => (
                <option key={g.value} value={g.value} />
              ))}
          </datalist>
        </label>

        {/* Steam link */}
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-ink-secondary">Steam page (optional)</span>
          {appid !== null ? (
            <div className="flex items-center gap-2.5 rounded-lg border border-chartborder bg-page p-2">
              {linked?.header_image && (
                <img src={linked.header_image} alt="" loading="lazy" className="h-9 w-16 shrink-0 rounded-sm object-cover" />
              )}
              <div className="min-w-0 flex-1 leading-tight">
                <div className="truncate text-sm font-medium text-ink-primary">{linked?.name ?? `App ${appid}`}</div>
                <div className="text-[11px] text-ink-muted">appid {appid}</div>
              </div>
              <button
                type="button"
                onClick={() => {
                  setAppid(null);
                  setLinked(null);
                }}
                className="shrink-0 rounded-md px-2 py-1 text-xs text-ink-muted hover:text-status-critical"
              >
                Unlink
              </button>
            </div>
          ) : (
            <>
              <GamePicker
                placeholder="Search for your game on Steam…"
                onPick={(g) => {
                  setAppid(g.appid);
                  setLinked({ name: g.name, header_image: g.header_image });
                }}
              />
              <span className="text-[11px] text-ink-muted">
                Leave blank while it's an unannounced draft — link it once it has a store page.
              </span>
            </>
          )}
        </div>

        <div className="flex items-center gap-3">
          <button type="submit" disabled={pending || !name.trim()} className={BTN_PRIMARY}>
            {pending ? "Saving…" : isEdit ? "Save changes" : "Create game"}
          </button>
          {canCancel && !isEdit && (
            <button type="button" onClick={onCancel} className={BTN_GHOST}>
              Cancel
            </button>
          )}
          {savedTick && <span className="text-xs font-medium text-status-good">Saved</span>}
          {mutErr && <span className="text-xs text-status-serious">{mutErr.message}</span>}
        </div>
      </form>
    </Card>
  );
}

// ---- competitors panel ------------------------------------------------------------------
function CompsCard({ projectId }: { projectId: number }) {
  const { data, isLoading, isError, error } = useComps(projectId);
  const add = useAddComp(projectId);
  const remove = useRemoveComp(projectId);

  return (
    <Card
      title="Competitors"
      subtitle="The games you're up against — track their live signals side by side with yours."
    >
      <GamePicker placeholder="Search games to add as a competitor…" onPick={(g) => add.mutate(g.appid)} />
      {add.isError && (
        <div className="mt-2 text-xs text-status-serious">
          {add.error instanceof Error ? add.error.message : "Failed to add competitor."}
        </div>
      )}

      <div className="mt-4 border-t border-chartborder pt-3">
        {isLoading && <div className="py-4 text-sm text-ink-muted">Loading competitors…</div>}
        {isError && (
          <div className="py-4 text-sm text-status-serious">
            Failed to load competitors{error instanceof Error ? `: ${error.message}` : "."}
          </div>
        )}
        {data && data.length === 0 && (
          <div className="py-4 text-sm text-ink-muted">No competitors yet — search above to add the games you're benchmarking against.</div>
        )}
        {data && data.length > 0 && (
          <ul className="flex flex-col">
            {data.map((c) => (
              <li key={c.id} className="flex items-center gap-3 border-b border-chartborder/60 py-2.5 last:border-0">
                <Link
                  to={`/games/${c.appid}`}
                  className="flex min-w-0 flex-1 items-center gap-2.5"
                >
                  {c.header_image && (
                    <img src={c.header_image} alt="" loading="lazy" className="h-9 w-16 shrink-0 rounded-sm object-cover" />
                  )}
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-ink-primary hover:text-brand hover:underline">
                      {c.name ?? `App ${c.appid}`}
                    </span>
                    <span className="block truncate text-[11px] text-ink-muted">{c.primary_genre ?? "—"}</span>
                  </span>
                </Link>
                <div className="hidden shrink-0 items-center gap-4 text-right sm:flex">
                  <div className="w-16">
                    <div className="tabular text-sm text-ink-primary">
                      {c.live_players != null ? fmtCompact(c.live_players) : "—"}
                    </div>
                    <div className="text-[10px] uppercase tracking-wide text-ink-muted">live</div>
                  </div>
                  <div className="w-16">
                    <div className="tabular text-sm text-ink-primary">{fmtCompact(c.total_reviews)}</div>
                    <div className="text-[10px] uppercase tracking-wide text-ink-muted">reviews</div>
                  </div>
                  <div className="w-12">
                    <div className="tabular text-sm text-ink-primary">{fmtPct(c.positive_ratio)}</div>
                    <div className="text-[10px] uppercase tracking-wide text-ink-muted">pos</div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => remove.mutate(c.appid)}
                  disabled={remove.isPending}
                  aria-label={`Remove ${c.name ?? c.appid} from competitors`}
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

// ---- project switcher -------------------------------------------------------------------
function SwitcherBar({
  projects,
  selectedId,
  onSelect,
  onNew,
  selected,
}: {
  projects: Project[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  onNew: () => void;
  selected: Project | null;
}) {
  const update = useUpdateProject();
  const del = useDeleteProject();

  return (
    <Card className="!p-4">
      <div className="flex flex-wrap items-center gap-2">
        {projects.map((p) => {
          const active = p.id === selectedId;
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => onSelect(p.id)}
              className={
                "flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-sm font-medium transition-colors " +
                (active
                  ? "border-brand bg-brand-tint text-brand"
                  : "border-chartborder bg-surface text-ink-secondary hover:bg-surface2 hover:text-ink-primary")
              }
            >
              <span className="truncate max-w-[160px]">{p.name}</span>
              {p.is_active && (
                <span className="rounded-full bg-brand-tint px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-brand">
                  Active
                </span>
              )}
            </button>
          );
        })}
        <button type="button" onClick={onNew} className={BTN_GHOST + " px-2.5 py-1.5"}>
          + New game
        </button>

        {selected && (
          <div className="ml-auto flex items-center gap-2">
            {!selected.is_active && (
              <button
                type="button"
                onClick={() => update.mutate({ id: selected.id, body: { is_active: true } })}
                disabled={update.isPending}
                className={BTN_GHOST + " px-2.5 py-1.5"}
              >
                Set active
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                if (window.confirm(`Delete "${selected.name}"? This also removes its competitors.`)) {
                  del.mutate(selected.id);
                }
              }}
              disabled={del.isPending}
              className="rounded-lg border border-chartborder bg-surface px-2.5 py-1.5 text-sm font-medium text-ink-muted transition-colors hover:border-status-critical hover:text-status-critical disabled:opacity-50"
            >
              Delete
            </button>
          </div>
        )}
      </div>
    </Card>
  );
}

// ---- page -------------------------------------------------------------------------------
export default function MyGame() {
  const { data: projects, isLoading, isError, error } = useProjects();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);

  // Keep a valid selection: default to the active project, else the first one.
  useEffect(() => {
    if (!projects || creating || projects.length === 0) return;
    setSelectedId((cur) =>
      cur !== null && projects.some((p) => p.id === cur)
        ? cur
        : projects.find((p) => p.is_active)?.id ?? projects[0].id,
    );
  }, [projects, creating]);

  const selected = useMemo(() => projects?.find((p) => p.id === selectedId) ?? null, [projects, selectedId]);
  const showCreate = creating || (!!projects && projects.length === 0);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold text-ink-primary">My Game</h1>
        <p className="mt-0.5 text-sm text-ink-muted">
          Your in-development game, its stage, and the competitors you're watching — the spine the whole
          watchtower pivots around.
        </p>
      </div>

      {isLoading && (
        <Card>
          <div className="py-6 text-sm text-ink-muted">Loading your games…</div>
        </Card>
      )}
      {isError && (
        <Card>
          <div className="py-6 text-sm text-status-serious">
            Failed to load projects{error instanceof Error ? `: ${error.message}` : "."}
          </div>
        </Card>
      )}

      {projects && projects.length > 0 && (
        <SwitcherBar
          projects={projects}
          selectedId={showCreate ? null : selectedId}
          onSelect={(id) => {
            setSelectedId(id);
            setCreating(false);
          }}
          onNew={() => setCreating(true)}
          selected={showCreate ? null : selected}
        />
      )}

      {showCreate ? (
        <ProjectFormCard
          onCreated={(p) => {
            setSelectedId(p.id);
            setCreating(false);
          }}
          onCancel={() => setCreating(false)}
          canCancel={!!projects && projects.length > 0}
        />
      ) : (
        selected && (
          <>
            <ProjectFormCard key={selected.id} project={selected} />
            <CompsCard key={`comps-${selected.id}`} projectId={selected.id} />
          </>
        )
      )}

      {projects && projects.length === 0 && !showCreate && (
        <Card>
          <EmptyState
            title="No game yet"
            description="Add your in-development game to unlock the watchtower dashboard."
            action={
              <button type="button" onClick={() => setCreating(true)} className={BTN_PRIMARY}>
                Create your game
              </button>
            }
          />
        </Card>
      )}
    </div>
  );
}
