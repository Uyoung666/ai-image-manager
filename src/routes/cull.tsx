import {
  createFileRoute,
  Outlet,
  useLocation,
  useMatch,
  useNavigate,
} from "@tanstack/react-router";
import { Eye, FolderOpen, Plus, Swords } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { cullActions } from "@/actions/cull";
import { shootingProjectActions } from "@/actions/shooting-projects";
import { CullFolderDrop } from "@/components/CullFolderDrop";
import { CullListHeader } from "@/components/CullListHeader";
import { CullTaskCard } from "@/components/CullTaskCard";
import { RouteError } from "@/components/RouteError";
import { ShootingProjectCreateDialog } from "@/components/ShootingProjectCreateDialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { SmoothInput } from "@/components/ui/smooth-input";
import { CULL_ARCHIVE_CHANGED } from "@/hooks/use-cull-task-archive";
import { useDirectCulling } from "@/hooks/use-direct-culling";
import { useRouteScrollRestoration } from "@/hooks/useRouteScrollRestoration";
import { ipc } from "@/ipc/manager";
import type { CullTaskSummary } from "@/types/cull";
import {
  readCullSearch,
  rememberCullReturn,
  saveCullSearch,
} from "@/utils/cull-navigation";

interface Folder {
  displayName: string;
  id: number;
  parentId: number | null;
  photoCount: number;
  totalPhotoCount?: number;
}

function CullListEmpty({
  archived,
  searching,
}: {
  archived: boolean;
  searching: boolean;
}) {
  const { t } = useTranslation();
  let title = archived ? "cullProject.archive.empty" : "cullNoSessions";
  let description = archived
    ? "cullProject.archive.emptyDescription"
    : "cullNoSessionsDesc";
  if (searching) {
    title = "cullProject.noMatches";
    description = "cullProject.noMatchesHint";
  }
  return (
    <div className="flex h-full items-center justify-center">
      <div className="max-w-80 text-center">
        <Swords className="mx-auto h-10 w-10 text-muted-foreground/40" />
        <p className="mt-3 font-medium text-base text-foreground">{t(title)}</p>
        <p className="mt-2 text-muted-foreground text-sm">{t(description)}</p>
        {!archived && (
          <p className="mt-4 text-muted-foreground text-xs">
            {t("cullHowToStart")}
          </p>
        )}
      </div>
    </div>
  );
}

export function CullListPage({
  archivedView = false,
}: {
  archivedView?: boolean;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const [tasks, setTasks] = useState<CullTaskSummary[]>([]);
  const [search, setSearch] = useState(() => readCullSearch(archivedView));
  const directCulling = useDirectCulling();
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const listRequest = useRef(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newMode, setNewMode] = useState<"duel" | "curate">("duel");
  const [newPkMode, setNewPkMode] = useState<"quick" | "standard" | "fine">(
    "standard"
  );
  const [newSortStrategy, setNewSortStrategy] = useState<"time" | "similarity">(
    "time"
  );
  const [folders, setFolders] = useState<Folder[]>([]);
  const [selectedFolderId, setSelectedFolderId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [savingTask, setSavingTask] = useState(false);
  const [pendingDeleteTask, setPendingDeleteTask] =
    useState<CullTaskSummary | null>(null);
  const [renameSession, setRenameSession] = useState<{
    task: CullTaskSummary;
    name: string;
  } | null>(null);
  const composingRef = useRef(false);
  const [noFolderHint, setNoFolderHint] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrolled, setScrolled] = useState(false);
  useRouteScrollRestoration(scrollRef, {
    getRouteKey: () =>
      `${archivedView ? "cull-archive" : "cull-list"}:${search}`,
    restoreReady: !loading,
    itemCount: tasks.length,
  });

  const loadSessions = useCallback(
    async (showInitialLoading = false) => {
      const request = ++listRequest.current;
      if (showInitialLoading) {
        setLoading(true);
      } else {
        setRefreshing(true);
      }
      try {
        const result = await cullActions.listTaskSummaries({
          search,
          archived: archivedView,
        });
        if (request !== listRequest.current) {
          return;
        }
        setListError(false);
        setTasks(result);
      } catch (err) {
        if (request !== listRequest.current) {
          return;
        }
        setListError(true);
        console.error("[loadSessions] failed:", err);
        toast.error(t("cullActionFailed"));
      } finally {
        if (request === listRequest.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [t, search, archivedView]
  );

  useEffect(() => {
    loadSessions(false);
    const refresh = () => {
      loadSessions();
    };
    window.addEventListener(CULL_ARCHIVE_CHANGED, refresh);
    return () => {
      window.removeEventListener(CULL_ARCHIVE_CHANGED, refresh);
      listRequest.current += 1;
    };
  }, [loadSessions]);

  const preparingTasks = tasks.some(
    (task) =>
      task.outputStatus === "pending" ||
      task.outputStatus === "running" ||
      task.scanStatus === "pending" ||
      task.scanStatus === "running"
  );
  useEffect(() => {
    if (!preparingTasks) {
      return;
    }
    const timer = setInterval(() => loadSessions(), 1500);
    return () => clearInterval(timer);
  }, [preparingTasks, loadSessions]);

  const loadFolders = useCallback(async () => {
    try {
      const result = await ipc.client.photos.getFolders({});
      setFolders(result as Folder[]);
    } catch (err) {
      console.error("[loadFolders] failed:", err);
      toast.error(t("cullActionFailed"));
    }
  }, [t]);

  function openTask(task: CullTaskSummary) {
    rememberCullReturn(
      task.kind,
      task.id,
      archivedView,
      location.state.cullSettingsReturn
    );
    if (task.kind === "project") {
      navigate({
        to: "/shooting-projects/$projectId",
        params: { projectId: task.id },
      });
    } else {
      navigate({
        to: "/cull/$sessionId",
        params: { sessionId: String(task.id) },
      });
    }
  }

  async function handleCreate() {
    if (creating) {
      return;
    }

    if (!selectedFolderId) {
      setNoFolderHint(true);
      return;
    }

    const selectedFolder = folders.find((f) => f.id === selectedFolderId);
    const sessionName =
      newName.trim() ||
      `${selectedFolder?.displayName ?? ""} - ${getModeLabel(newMode)}`;

    setCreating(true);
    setNoFolderHint(false);
    try {
      const result = (await cullActions.createSession({
        name: sessionName,
        mode: newMode,
        pkMode: newPkMode,
        sortStrategy: newSortStrategy,
        photoIds: [],
        folderId: selectedFolderId,
      })) as { id: number };
      setCreateOpen(false);
      navigate({
        to: "/cull/$sessionId",
        params: { sessionId: String(result.id) },
      });
    } catch (err) {
      console.error("[handleCreate] failed:", err);
      toast.error(t("cullCreateSessionFailed"));
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(task: CullTaskSummary) {
    if (savingTask) {
      return;
    }
    setSavingTask(true);
    try {
      if (task.kind === "project") {
        await shootingProjectActions.delete(task.id);
      } else {
        await cullActions.deleteSession({ sessionId: task.id });
      }
      setTasks((current) =>
        current.filter((item) => item.kind !== task.kind || item.id !== task.id)
      );
      setPendingDeleteTask(null);
      toast.success(t("cullSessionDeleted"));
    } catch (err) {
      console.error("[handleDelete] failed:", err);
      toast.error(t("cullActionFailed"));
    } finally {
      setSavingTask(false);
    }
  }

  async function handleDuplicate(sessionId: number) {
    try {
      await cullActions.duplicateSession({ sessionId });
      await loadSessions();
      toast.success(t("cullSessionDuplicated"));
    } catch (error) {
      console.error("[handleDuplicate] failed:", error);
      toast.error(t("cullActionFailed"));
    }
  }

  async function handleRename() {
    if (savingTask || !renameSession?.name.trim()) {
      return;
    }
    setSavingTask(true);
    try {
      const { task } = renameSession;
      if (task.kind === "project") {
        await shootingProjectActions.rename({
          projectId: task.id,
          name: renameSession.name.trim(),
        });
      } else {
        await cullActions.renameSession({
          sessionId: task.id,
          name: renameSession.name.trim(),
        });
      }
      await loadSessions();
      setRenameSession(null);
    } catch (error) {
      console.error("[handleRename] failed:", error);
      toast.error(t("cullActionFailed"));
    } finally {
      setSavingTask(false);
    }
  }

  function getModeIcon(mode: string) {
    return mode === "curate" ? (
      <Eye className="h-3.5 w-3.5" />
    ) : (
      <Swords className="h-3.5 w-3.5" />
    );
  }

  function getModeLabel(mode: string): string {
    return mode === "curate" ? t("cullModeCurate") : t("cullModeDuel");
  }

  const visibleCount = tasks.length;

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <LoadingSpinner size="xl" />
      </div>
    );
  }

  return (
    <CullFolderDrop
      disabled={directCulling.busy}
      enabled={!archivedView}
      onFolder={directCulling.openFromPath}
    >
      <div
        aria-busy={refreshing}
        className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]"
        data-testid="cull-list-scroll"
        onScroll={(event) => setScrolled(event.currentTarget.scrollTop > 4)}
        ref={scrollRef}
      >
        <CullListHeader
          archived={archivedView}
          count={visibleCount}
          onArchive={() =>
            navigate({
              to: archivedView ? "/cull" : "/settings/cull-archive",
              state: { cullSettingsReturn: !archivedView },
            })
          }
          onHome={() => navigate({ to: "/" })}
          onSearch={(value) => {
            setSearch(value);
            saveCullSearch(archivedView, value);
          }}
          scrolled={scrolled}
          search={search}
        >
          {!archivedView && (
            <>
              <Button
                className="h-auto min-h-8 max-w-full whitespace-normal"
                data-testid="cull-open-folder"
                disabled={directCulling.opening}
                onClick={directCulling.open}
                size="lg"
                type="button"
              >
                <FolderOpen className="h-4 w-4" />
                {t("cullProject.openFolder")}
              </Button>
              <Button
                className="h-auto min-h-8 max-w-full whitespace-normal"
                onClick={() => {
                  setNewName("");
                  setNewMode("duel");
                  setNewPkMode("standard");
                  setNewSortStrategy("time");
                  setSelectedFolderId(null);
                  setNoFolderHint(false);
                  loadFolders();
                  setCreateOpen(true);
                }}
                size="lg"
                type="button"
                variant="outline"
              >
                <Plus className="h-3.5 w-3.5" />
                {t("cullProject.fromLibrary")}
              </Button>
            </>
          )}
        </CullListHeader>
        <div className="min-h-0 p-3 sm:p-6">
          {refreshing && (
            <div className="pointer-events-none absolute top-4 right-4 z-10 rounded-full bg-background/80 p-2 shadow-sm">
              <LoadingSpinner size="sm" />
            </div>
          )}
          {listError && (
            <div className="flex flex-wrap items-center gap-2 p-3" role="alert">
              <p className="text-destructive text-sm">
                {t("cullActionFailed")}
              </p>
              <button
                className="rounded border px-3 py-2 text-xs"
                onClick={() => loadSessions()}
                type="button"
              >
                {t("retry")}
              </button>
            </div>
          )}
          {!listError && visibleCount === 0 && (
            <CullListEmpty
              archived={archivedView}
              searching={Boolean(search.trim())}
            />
          )}
          {!listError && visibleCount > 0 && (
            <div
              className="grid items-stretch gap-4"
              data-testid="cull-task-grid"
              style={{
                gridTemplateColumns:
                  "repeat(auto-fill, minmax(min(300px, 100%), 1fr))",
              }}
            >
              {tasks.map((task) => (
                <CullTaskCard
                  key={`${task.kind}:${task.id}`}
                  onDelete={() => setPendingDeleteTask(task)}
                  onDuplicate={
                    task.kind === "library"
                      ? () => handleDuplicate(task.id)
                      : undefined
                  }
                  onOpen={() => openTask(task)}
                  onRename={() => setRenameSession({ task, name: task.name })}
                  task={task}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {directCulling.source && (
        <ShootingProjectCreateDialog
          initialSource={directCulling.source}
          onClose={directCulling.close}
          onCreated={directCulling.complete}
        />
      )}

      {/* Create dialog */}
      <Dialog
        onOpenChange={(open) => !open && setCreateOpen(false)}
        open={createOpen}
      >
        <DialogContent className="max-h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] max-w-[400px] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t("cullNew")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            {/* Name */}
            <div>
              <label
                className="mb-1 block text-[12px] text-muted-foreground"
                htmlFor="cull-session-name"
              >
                {t("cullSessionName")}
              </label>
              <SmoothInput
                className="w-full rounded-[6px] border border-input bg-transparent px-3 py-2 text-[13px] text-foreground outline-none focus:border-primary"
                id="cull-session-name"
                onChange={(e) => setNewName(e.target.value)}
                onCompositionEnd={() => {
                  composingRef.current = false;
                }}
                onCompositionStart={() => {
                  composingRef.current = true;
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !composingRef.current) {
                    handleCreate();
                  }
                }}
                placeholder={t("cullSessionNamePlaceholder")}
                value={newName}
              />
            </div>

            {/* Mode */}
            <div>
              <p className="mb-1 block text-[12px] text-muted-foreground">
                {t("cullMode")}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {(["duel", "curate"] as const).map((mode) => (
                  <button
                    className={`flex items-center gap-1 rounded-[6px] px-3 py-1.5 text-[12px] transition-colors ${
                      newMode === mode
                        ? "bg-primary/10 font-medium text-primary"
                        : "text-muted-foreground hover:bg-muted"
                    }`}
                    key={mode}
                    onClick={() => setNewMode(mode)}
                    type="button"
                  >
                    {getModeIcon(mode)}
                    {getModeLabel(mode)}
                  </button>
                ))}
              </div>
            </div>

            {/* Sort strategy (only for curate) */}
            {newMode === "curate" && (
              <div>
                <p className="mb-1 block text-[12px] text-muted-foreground">
                  {t("cullSortStrategy")}
                </p>
                <div className="space-y-1">
                  {(["time", "similarity"] as const).map((strategy) => (
                    <button
                      className={`w-full rounded-[6px] px-3 py-2 text-left text-[12px] transition-colors ${
                        newSortStrategy === strategy
                          ? "bg-primary/10 font-medium text-primary"
                          : "text-muted-foreground hover:bg-muted"
                      }`}
                      key={strategy}
                      onClick={() => setNewSortStrategy(strategy)}
                      type="button"
                    >
                      <div className="font-medium">
                        {strategy === "time"
                          ? t("cullSortByTime")
                          : t("cullSortBySimilarity")}
                      </div>
                      <div className="break-words text-[10px] text-muted-foreground/60">
                        {strategy === "time"
                          ? t("cullSortByTimeDesc")
                          : t("cullSortBySimilarityDesc")}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* PK sub-mode (only for duel) */}
            {newMode === "duel" && (
              <div>
                <p className="mb-1 block text-[12px] text-muted-foreground">
                  {t("cullPkModeLabel")}
                </p>
                <div className="space-y-1">
                  {(["quick", "standard", "fine"] as const).map((mode) => (
                    <button
                      className={`w-full rounded-[6px] px-3 py-2 text-left text-[12px] transition-colors ${
                        newPkMode === mode
                          ? "bg-primary/10 font-medium text-primary"
                          : "text-muted-foreground hover:bg-muted"
                      }`}
                      key={mode}
                      onClick={() => setNewPkMode(mode)}
                      type="button"
                    >
                      <div className="font-medium">
                        {(() => {
                          const labels: Record<string, string> = {
                            quick: t("cullPkModeQuick"),
                            standard: t("cullPkModeStandard"),
                            fine: t("cullPkModeFine"),
                          };
                          return labels[mode];
                        })()}
                      </div>
                      <div className="break-words text-[10px] text-muted-foreground/60">
                        {(() => {
                          const labels: Record<string, string> = {
                            quick: t("cullPkModeQuickDesc"),
                            standard: t("cullPkModeStandardDesc"),
                            fine: t("cullPkModeFineDesc"),
                          };
                          return labels[mode];
                        })()}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Folder selector */}
            <div>
              <p className="mb-1 block text-[12px] text-muted-foreground">
                {t("cullSelectFolder")}
              </p>
              {folders.length === 0 ? (
                <p className="text-[11px] text-muted-foreground/50">
                  {t("cullNoFolders")}
                </p>
              ) : (
                <div className="max-h-[160px] space-y-1 overflow-y-auto">
                  {folders.map((f) => (
                    <button
                      className={`w-full rounded-[6px] px-3 py-2 text-left text-[12px] transition-colors ${
                        selectedFolderId === f.id
                          ? "bg-primary/10 font-medium text-primary"
                          : "text-muted-foreground hover:bg-muted"
                      }`}
                      key={f.id}
                      onClick={() =>
                        setSelectedFolderId(
                          selectedFolderId === f.id ? null : f.id
                        )
                      }
                      type="button"
                    >
                      <span className="break-all">{f.displayName}</span>
                      <span className="ml-2 text-[10px] text-muted-foreground/50">
                        ({f.totalPhotoCount ?? f.photoCount})
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <p className="text-[11px] text-muted-foreground/60">
              {t("cullCreateHint")}
            </p>

            {noFolderHint && (
              <p className="text-[11px] text-destructive">
                {t("cullSelectFolderHint")}
              </p>
            )}

            {/* Actions */}
            <div className="flex flex-wrap justify-end gap-2 pt-2">
              <button
                className="rounded-[6px] px-4 py-2 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
                onClick={() => setCreateOpen(false)}
                type="button"
              >
                {t("cancel")}
              </button>
              <button
                className="rounded-[6px] bg-primary px-4 py-2 text-[12px] text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
                disabled={creating}
                onClick={handleCreate}
                type="button"
              >
                {t("cullStart")}
              </button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        onOpenChange={(open) => !(open || savingTask) && setRenameSession(null)}
        open={renameSession !== null}
      >
        <DialogContent
          aria-describedby={undefined}
          className="max-h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] max-w-[360px] overflow-y-auto"
        >
          <DialogHeader>
            <DialogTitle>
              {t(
                renameSession?.task.kind === "project"
                  ? "shootingProject.rename"
                  : "cullRenameSession"
              )}
            </DialogTitle>
          </DialogHeader>
          <SmoothInput
            aria-label={t("cullSessionName")}
            className="rounded-[6px] border border-input bg-transparent px-3 py-2 text-[13px] outline-none focus:border-primary"
            disabled={savingTask}
            maxLength={200}
            onChange={(event) =>
              setRenameSession((current) =>
                current ? { ...current, name: event.target.value } : null
              )
            }
            value={renameSession?.name ?? ""}
          />
          <div className="flex flex-wrap justify-end gap-2">
            <button
              disabled={savingTask}
              onClick={() => setRenameSession(null)}
              type="button"
            >
              {t("cancel")}
            </button>
            <button
              className="rounded-[6px] bg-primary px-4 py-2 text-[12px] text-primary-foreground"
              disabled={savingTask || !renameSession?.name.trim()}
              onClick={handleRename}
              type="button"
            >
              {t("confirm")}
            </button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        onOpenChange={(open) =>
          !(open || savingTask) && setPendingDeleteTask(null)
        }
        open={pendingDeleteTask !== null}
      >
        <DialogContent className="max-h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] max-w-[360px] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {t(
                pendingDeleteTask?.kind === "project"
                  ? "shootingProject.delete"
                  : "cullDeleteSessionTitle"
              )}
            </DialogTitle>
          </DialogHeader>
          <DialogDescription className="text-[13px] text-muted-foreground">
            {t(
              pendingDeleteTask?.kind === "project"
                ? "shootingProject.deleteDescription"
                : "cullDeleteSessionDescription"
            )}
          </DialogDescription>
          <div className="flex flex-wrap justify-end gap-2 pt-2">
            <button
              className="rounded-[6px] px-4 py-2 text-[12px] text-muted-foreground"
              disabled={savingTask}
              onClick={() => setPendingDeleteTask(null)}
              type="button"
            >
              {t("cancel")}
            </button>
            <button
              className="rounded-[6px] bg-destructive px-4 py-2 text-[12px] text-destructive-foreground"
              disabled={savingTask}
              onClick={() => {
                if (pendingDeleteTask !== null) {
                  handleDelete(pendingDeleteTask);
                }
              }}
              type="button"
            >
              {t("delete")}
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </CullFolderDrop>
  );
}

function CullLayout() {
  const childMatch = useMatch({
    from: "/cull/$sessionId",
    shouldThrow: false,
  });
  if (childMatch) {
    return <Outlet />;
  }
  return <CullListPage />;
}

export const Route = createFileRoute("/cull")({
  component: CullLayout,
  errorComponent: RouteError,
});
