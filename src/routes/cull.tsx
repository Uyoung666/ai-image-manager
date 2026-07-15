import {
  createFileRoute,
  Outlet,
  useMatch,
  useNavigate,
} from "@tanstack/react-router";
import { ArrowLeft, Eye, Plus, Swords } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { CullSessionCard } from "@/components/CullSessionCard";
import { RouteError } from "@/components/RouteError";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useRouteScrollRestoration } from "@/hooks/useRouteScrollRestoration";
import { ipc } from "@/ipc/manager";

interface CullSession {
  completedAt: number | null;
  completedComparisons: number;
  createdAt: number;
  id: number;
  mode: "duel" | "curate";
  name: string;
  pkMode?: string;
  status: "active" | "completed";
  totalPhotos: number;
}

interface Folder {
  displayName: string;
  id: number;
  parentId: number | null;
  photoCount: number;
  totalPhotoCount?: number;
}

function CullListPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<CullSession[]>([]);
  const [loading, setLoading] = useState(true);
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
  const [pendingDeleteSessionId, setPendingDeleteSessionId] = useState<
    number | null
  >(null);
  const [renameSession, setRenameSession] = useState<{
    id: number;
    name: string;
  } | null>(null);
  const composingRef = useRef(false);
  const [noFolderHint, setNoFolderHint] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  useRouteScrollRestoration(scrollRef, { getRouteKey: () => "cull-list" });

  const loadSessions = useCallback(async () => {
    setLoading(true);
    try {
      const result = await ipc.client.cull.listSessions({});
      setSessions(result as CullSession[]);
    } catch (err) {
      console.error("[loadSessions] failed:", err);
      toast.error(t("cullActionFailed"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  const loadFolders = useCallback(async () => {
    try {
      const result = await ipc.client.photos.getFolders({});
      setFolders(result as Folder[]);
    } catch (err) {
      console.error("[loadFolders] failed:", err);
      toast.error(t("cullActionFailed"));
    }
  }, []);

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
      const result = (await ipc.client.cull.createSession({
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

  async function handleDelete(sessionId: number) {
    try {
      await ipc.client.cull.deleteSession({ sessionId });
      setSessions((prev) => prev.filter((s) => s.id !== sessionId));
      setPendingDeleteSessionId(null);
      toast.success(t("cullSessionDeleted"));
    } catch (err) {
      console.error("[handleDelete] failed:", err);
      toast.error(t("cullActionFailed"));
    }
  }

  async function handleDuplicate(sessionId: number) {
    try {
      await ipc.client.cull.duplicateSession({ sessionId });
      await loadSessions();
      toast.success(t("cullSessionDuplicated"));
    } catch (error) {
      console.error("[handleDuplicate] failed:", error);
      toast.error(t("cullActionFailed"));
    }
  }

  async function handleRename() {
    if (!renameSession?.name.trim()) {
      return;
    }
    try {
      await ipc.client.cull.renameSession({
        sessionId: renameSession.id,
        name: renameSession.name.trim(),
      });
      setSessions((current) =>
        current.map((session) =>
          session.id === renameSession.id
            ? { ...session, name: renameSession.name.trim() }
            : session
        )
      );
      setRenameSession(null);
    } catch (error) {
      console.error("[handleRename] failed:", error);
      toast.error(t("cullActionFailed"));
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

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <LoadingSpinner size="xl" />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Header */}
      <div className="flex items-center justify-between border-border border-b px-6 py-4">
        <div className="flex items-center gap-4">
          <button
            className="text-muted-foreground hover:text-foreground"
            onClick={() => navigate({ to: "/" })}
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <h1 className="font-semibold text-[18px] text-foreground">
            {t("cullTitle")}
          </h1>
          <span className="text-[13px] text-muted-foreground/70">
            {t("cullSessionCount", { count: sessions.length })}
          </span>
        </div>
        <button
          className="flex items-center gap-1.5 rounded-[6px] bg-primary px-3 py-1.5 text-[12px] text-primary-foreground transition-colors hover:bg-primary/90"
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
        >
          <Plus className="h-3.5 w-3.5" />
          {t("cullNew")}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-6" ref={scrollRef}>
        {sessions.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <div className="max-w-[320px] text-center">
              <Swords className="mx-auto h-10 w-10 text-muted-foreground/40" />
              <p className="mt-3 font-medium text-[16px] text-foreground">
                {t("cullNoSessions")}
              </p>
              <p className="mt-2 text-[13px] text-muted-foreground/70">
                {t("cullNoSessionsDesc")}
              </p>
              <p className="mt-4 text-[12px] text-muted-foreground/50">
                {t("cullHowToStart")}
              </p>
            </div>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {sessions.map((session) => (
              <CullSessionCard
                getModeIcon={getModeIcon}
                getModeLabel={getModeLabel}
                key={session.id}
                onClick={() =>
                  navigate({
                    to: "/cull/$sessionId",
                    params: { sessionId: String(session.id) },
                  })
                }
                onDelete={() => setPendingDeleteSessionId(session.id)}
                onDuplicate={() => handleDuplicate(session.id)}
                onRename={() =>
                  setRenameSession({ id: session.id, name: session.name })
                }
                session={session}
              />
            ))}
          </div>
        )}
      </div>

      {/* Create dialog */}
      <Dialog
        onOpenChange={(open) => !open && setCreateOpen(false)}
        open={createOpen}
      >
        <DialogContent className="max-w-[400px]">
          <DialogHeader>
            <DialogTitle>{t("cullNew")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            {/* Name */}
            <div>
              <label className="mb-1 block text-[12px] text-muted-foreground">
                {t("cullSessionName")}
              </label>
              <input
                className="w-full rounded-[6px] border border-input bg-transparent px-3 py-2 text-[13px] text-foreground outline-none focus:border-primary"
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
              <label className="mb-1 block text-[12px] text-muted-foreground">
                {t("cullMode")}
              </label>
              <div className="flex gap-1.5">
                {(["duel", "curate"] as const).map((mode) => (
                  <button
                    className={`flex items-center gap-1 rounded-[6px] px-3 py-1.5 text-[12px] transition-colors ${
                      newMode === mode
                        ? "bg-primary/10 font-medium text-primary"
                        : "text-muted-foreground hover:bg-muted"
                    }`}
                    key={mode}
                    onClick={() => setNewMode(mode)}
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
                <label className="mb-1 block text-[12px] text-muted-foreground">
                  {t("cullSortStrategy")}
                </label>
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
                    >
                      <div className="font-medium">
                        {strategy === "time"
                          ? t("cullSortByTime")
                          : t("cullSortBySimilarity")}
                      </div>
                      <div className="text-[10px] text-muted-foreground/60">
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
                <label className="mb-1 block text-[12px] text-muted-foreground">
                  {t("cullPkModeLabel")}
                </label>
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
                      <div className="text-[10px] text-muted-foreground/60">
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
              <label className="mb-1 block text-[12px] text-muted-foreground">
                {t("cullSelectFolder")}
              </label>
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
                    >
                      {f.displayName}
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
            <div className="flex justify-end gap-2 pt-2">
              <button
                className="rounded-[6px] px-4 py-2 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
                onClick={() => setCreateOpen(false)}
              >
                {t("cancel")}
              </button>
              <button
                className="rounded-[6px] bg-primary px-4 py-2 text-[12px] text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
                disabled={creating}
                onClick={handleCreate}
              >
                {t("cullStart")}
              </button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        onOpenChange={(open) => !open && setRenameSession(null)}
        open={renameSession !== null}
      >
        <DialogContent className="max-w-[360px]">
          <DialogHeader>
            <DialogTitle>{t("cullRenameSession")}</DialogTitle>
          </DialogHeader>
          <input
            className="rounded-[6px] border border-input bg-transparent px-3 py-2 text-[13px] outline-none focus:border-primary"
            onChange={(event) =>
              setRenameSession((current) =>
                current ? { ...current, name: event.target.value } : null
              )
            }
            value={renameSession?.name ?? ""}
          />
          <div className="flex justify-end gap-2">
            <button onClick={() => setRenameSession(null)} type="button">
              {t("cancel")}
            </button>
            <button
              className="rounded-[6px] bg-primary px-4 py-2 text-[12px] text-primary-foreground"
              onClick={handleRename}
              type="button"
            >
              {t("confirm")}
            </button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        onOpenChange={(open) => !open && setPendingDeleteSessionId(null)}
        open={pendingDeleteSessionId !== null}
      >
        <DialogContent className="max-w-[360px]">
          <DialogHeader>
            <DialogTitle>{t("cullDeleteSessionTitle")}</DialogTitle>
          </DialogHeader>
          <p className="text-[13px] text-muted-foreground">
            {t("cullDeleteSessionDescription")}
          </p>
          <div className="flex justify-end gap-2 pt-2">
            <button
              className="rounded-[6px] px-4 py-2 text-[12px] text-muted-foreground"
              onClick={() => setPendingDeleteSessionId(null)}
              type="button"
            >
              {t("cancel")}
            </button>
            <button
              className="rounded-[6px] bg-destructive px-4 py-2 text-[12px] text-destructive-foreground"
              onClick={() => {
                if (pendingDeleteSessionId !== null) {
                  handleDelete(pendingDeleteSessionId);
                }
              }}
              type="button"
            >
              {t("delete")}
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
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
