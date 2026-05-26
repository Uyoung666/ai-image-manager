import {
  createFileRoute,
  Link,
  Outlet,
  useMatch,
  useNavigate,
} from "@tanstack/react-router";
import {
  ArrowLeft,
  Check,
  Merge,
  Play,
  RefreshCw,
  Trash2,
  User,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ipc } from "@/ipc/manager";

interface FaceIdentity {
  coverBbox: { x: number; y: number; width: number; height: number } | null;
  coverPhotoHeight: number | null;
  coverPhotoWidth: number | null;
  coverThumbnailPath: string | null;
  createdAt: number;
  faceCount: number;
  id: number;
  name: string | null;
  representativePhotoId: number | null;
}

function PeoplePage() {
  const { t } = useTranslation();
  const [identities, setIdentities] = useState<FaceIdentity[]>([]);
  const [loading, setLoading] = useState(true);
  const [detecting, setDetecting] = useState(false);
  const [progress, setProgress] = useState<string>("");
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState<{
    id: number;
    name: string | null;
  } | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [nameInput, setNameInput] = useState("");
  const composingRef = useRef(false);
  const navigate = useNavigate();

  const loadIdentities = useCallback(async () => {
    try {
      const result = await ipc.client.faces.listFaceIdentities({});
      setIdentities(result as FaceIdentity[]);
    } catch (err) {
      console.error("[loadIdentities] failed:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadIdentities();
  }, [loadIdentities]);

  async function handleStartDetection(rescan = false) {
    setDetecting(true);
    setProgress(rescan ? t("restartingFaceDetection") : t("startingFaceDetection"));
    try {
      const result = (await ipc.client.faces.startFaceDetection({
        rescan,
      })) as { started: boolean; photoCount?: number; message?: string };
      if (result.started) {
        setProgress(t("detectingFacesCount", { count: result.photoCount }));
        // Poll for progress
        const poll = setInterval(async () => {
          try {
            const p = (await ipc.client.faces.getDetectionProgress({})) as {
              phase: string;
              processed: number;
              total?: number;
            };
            if (p.phase === "complete") {
              setProgress(t("detectionCompleteCount", { count: p.processed }));
              clearInterval(poll);
              setDetecting(false);
              loadIdentities();
            } else if (p.phase === "running") {
              setProgress(t("detectingFacesProgress", { processed: p.processed, total: p.total }));
            } else {
              clearInterval(poll);
              setDetecting(false);
              setProgress("");
            }
          } catch (err) {
            console.error("[detectionPoll] failed:", err);
            clearInterval(poll);
            setDetecting(false);
          }
        }, 2000);
      } else {
        setProgress(result.message || t("startFailed"));
        setDetecting(false);
      }
    } catch {
      setProgress(t("startFaceDetectionFailed"));
      setDetecting(false);
    }
  }

  async function handleRecluster() {
    setDetecting(true);
    setProgress(t("reclustering"));
    try {
      const result = (await ipc.client.faces.recluster({})) as {
        ok: boolean;
        identityCount?: number;
        message?: string;
      };
      if (result.ok) {
        setProgress(t("reclusterCompleteCount", { count: result.identityCount }));
        loadIdentities();
      } else {
        setProgress(result.message || t("reclusterFailed"));
      }
    } catch {
      setProgress(t("reclusterException"));
    } finally {
      setDetecting(false);
    }
  }

  function handleDeleteIdentity(id: number, name: string | null) {
    setConfirmDelete({ id, name });
  }

  async function performDeleteIdentity() {
    if (!confirmDelete) {
      return;
    }
    const { id } = confirmDelete;
    setConfirmDelete(null);
    try {
      await ipc.client.faces.deleteFaceIdentity({ id });
      loadIdentities();
    } catch {
      toast.error(t("deletePersonFailed"));
    }
  }

  async function handleMerge() {
    if (selected.size < 2) {
      return;
    }
    const ids = [...selected];
    // Pick the one with most faces as target
    const sorted = ids
      .map((id) => identities.find((i) => i.id === id)!)
      .filter(Boolean)
      .sort((a, b) => b.faceCount - a.faceCount);
    const targetId = sorted[0].id;
    const sourceIds = ids.filter((id) => id !== targetId);

    try {
      await ipc.client.faces.mergeIdentities({ targetId, sourceIds });
      setSelectMode(false);
      setSelected(new Set());
      loadIdentities();
    } catch {
      toast.error(t("mergePeopleFailed"));
    }
  }

  function toggleSelect(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  function exitSelectMode() {
    setSelectMode(false);
    setSelected(new Set());
  }

  function startEditing(id: number, currentName: string | null) {
    setEditingId(id);
    setNameInput(currentName || "");
  }

  function cancelEditing() {
    setEditingId(null);
  }

  async function handleRename(id: number) {
    const newName = nameInput.trim();
    try {
      await ipc.client.faces.updateFaceIdentity({ id, name: newName });
      setIdentities((prev) =>
        prev.map((i) => (i.id === id ? { ...i, name: newName || null } : i))
      );
    } catch {
      toast.error(t("personRenameFailed"));
    } finally {
      setEditingId((current) => (current === id ? null : current));
    }
  }

  function toLocalMediaUrl(filePath: string): string {
    const encoded = filePath
      .replace(/\\/g, "/")
      .split("/")
      .map((s) => encodeURIComponent(s))
      .join("/");
    return `local-media://${encoded}`;
  }

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Header */}
      <div className="flex items-center justify-between border-border border-b px-6 py-4">
        <div className="flex items-center gap-3">
          <button
            className="flex h-8 w-8 items-center justify-center rounded-[6px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
            onClick={() => navigate({ to: "/" })}
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div>
            <h1 className="font-[590] text-[24px] text-foreground tracking-tight">
              {t("people")}
            </h1>
            <p className="mt-0.5 text-[12px] text-muted-foreground/70">
              {identities.length > 0
                ? t("peopleCount", { count: identities.length })
                : t("peopleDescription")}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {selectMode ? (
            <>
              <span className="text-[13px] text-muted-foreground">
                {t("selectedPeopleCount", { count: selected.size })}
              </span>
              <button
                className="flex items-center gap-1.5 rounded-[6px] bg-primary px-4 py-1.5 font-[510] text-[13px] text-white transition-opacity hover:opacity-90 disabled:opacity-40"
                disabled={selected.size < 2}
                onClick={handleMerge}
              >
                <Merge className="h-3.5 w-3.5" />
                {t("mergeAsSamePerson")}
              </button>
              <button
                className="flex h-8 w-8 items-center justify-center rounded-[6px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
                onClick={exitSelectMode}
                title={t("clearSelection")}
              >
                <X className="h-4 w-4" />
              </button>
            </>
          ) : (
            <>
              {identities.length > 1 && (
                <button
                  className="flex items-center gap-1.5 rounded-[6px] border border-border px-3 py-1.5 font-[510] text-[13px] text-foreground transition-colors hover:bg-foreground/5 disabled:opacity-40"
                  disabled={detecting}
                  onClick={() => setSelectMode(true)}
                  title={t("mergePeopleHint")}
                >
                  <Merge className="h-3.5 w-3.5" />
                  {t("mergePeople")}
                </button>
              )}
              {identities.length > 0 && (
                <>
                  <button
                    className="flex items-center gap-1.5 rounded-[6px] border border-border px-3 py-1.5 font-[510] text-[13px] text-foreground transition-colors hover:bg-foreground/5 disabled:opacity-40"
                    disabled={detecting}
                    onClick={handleRecluster}
                    title={t("reclusterFacesHint")}
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    {t("reclusterFaces")}
                  </button>
                  <button
                    className="flex items-center gap-1.5 rounded-[6px] border border-border px-3 py-1.5 font-[510] text-[13px] text-foreground transition-colors hover:bg-foreground/5 disabled:opacity-40"
                    disabled={detecting}
                    onClick={() => handleStartDetection(true)}
                    title={t("rescanFacesHint")}
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    {t("rescan")}
                  </button>
                </>
              )}
              <button
                className="flex items-center gap-1.5 rounded-[6px] bg-primary px-4 py-1.5 font-[510] text-[13px] text-white transition-opacity hover:opacity-90 disabled:opacity-40"
                disabled={detecting}
                onClick={() => handleStartDetection(false)}
              >
                <Play className="h-3.5 w-3.5" />
                {detecting ? t("faceDetecting") : t("startFaceDetection")}
              </button>
            </>
          )}
        </div>
      </div>

      {/* Progress */}
      {progress && (
        <div className="border-border border-b bg-primary/5 px-6 py-2 text-[12px] text-primary">
          {detecting && (
            <span className="mr-2 inline-block h-3 w-3 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          )}
          {progress}
        </div>
      )}

      {/* Grid */}
      <div className="flex-1 overflow-y-auto p-6">
        {loading ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <div
                className="aspect-[3/4] animate-pulse rounded-[8px] bg-card"
                key={i}
              />
            ))}
          </div>
        ) : identities.length === 0 ? (
          <div className="flex h-64 flex-col items-center justify-center gap-3 text-muted-foreground/70">
            <User className="h-12 w-12 opacity-20" />
            <p className="text-[13px]">{t("noPeopleTitle")}</p>
            <p className="text-[11px] text-muted-foreground/70/60">
              {t("noPeopleDescription")}
            </p>
            <button
              className="mt-2 rounded-[6px] bg-primary px-4 py-1.5 font-[510] text-[13px] text-white transition-opacity hover:opacity-90"
              disabled={detecting}
              onClick={() => handleStartDetection(false)}
            >
              {t("startFaceDetectionShort")}
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-4">
            {identities.map((identity) => (
              <div
                className={`group relative overflow-hidden rounded-[8px] border bg-card transition-colors ${
                  selected.has(identity.id)
                    ? "border-primary ring-2 ring-primary/30"
                    : "border-border hover:border-primary/30"
                } ${selectMode ? "cursor-pointer" : ""}`}
                key={identity.id}
                onClick={
                  selectMode ? () => toggleSelect(identity.id) : undefined
                }
              >
                {selectMode ? (
                  <div className="block">
                    <div className="aspect-square overflow-hidden bg-muted">
                      {identity.coverThumbnailPath ? (
                        (() => {
                          const bbox = identity.coverBbox;
                          const pw = identity.coverPhotoWidth;
                          const ph = identity.coverPhotoHeight;
                          if (bbox && pw && ph) {
                            const cx = ((bbox.x + bbox.width / 2) / pw) * 100;
                            const cy = ((bbox.y + bbox.height / 2) / ph) * 100;
                            const faceRatio = Math.max(
                              bbox.width / pw,
                              bbox.height / ph
                            );
                            const zoom = Math.min(
                              Math.max(1 / (faceRatio * 2.2), 1.2),
                              4
                            );
                            return (
                              <img
                                alt={identity.name || t("unnamedPerson")}
                                className="h-full w-full object-cover"
                                src={toLocalMediaUrl(
                                  identity.coverThumbnailPath
                                )}
                                style={{
                                  objectPosition: `${cx}% ${cy}%`,
                                  transform: `scale(${zoom})`,
                                  transformOrigin: `${cx}% ${cy}%`,
                                }}
                              />
                            );
                          }
                          return (
                            <img
                              alt={identity.name || t("unnamedPerson")}
                              className="h-full w-full object-cover"
                              src={toLocalMediaUrl(identity.coverThumbnailPath)}
                            />
                          );
                        })()
                      ) : (
                        <div className="flex h-full w-full items-center justify-center">
                          <User className="h-12 w-12 text-muted-foreground/30" />
                        </div>
                      )}
                    </div>
                    <div className="p-3">
                      <h3 className="truncate font-[510] text-[13px] text-foreground">
                        {identity.name || t("unnamedPerson")}
                      </h3>
                      <p className="mt-0.5 text-[11px] text-muted-foreground/70">
                        {identity.faceCount} {t("photos")}
                      </p>
                    </div>
                    {selected.has(identity.id) && (
                      <div className="absolute top-2 left-2 flex h-6 w-6 items-center justify-center rounded-full bg-primary text-white">
                        <Check className="h-3.5 w-3.5" />
                      </div>
                    )}
                  </div>
                ) : (
                  <>
                    <Link
                      className="block"
                      params={{ identityId: identity.id.toString() }}
                      to="/people/$identityId"
                    >
                      <div className="aspect-square overflow-hidden bg-muted">
                        {identity.coverThumbnailPath ? (
                          (() => {
                            const bbox = identity.coverBbox;
                            const pw = identity.coverPhotoWidth;
                            const ph = identity.coverPhotoHeight;
                            if (bbox && pw && ph) {
                              const cx = ((bbox.x + bbox.width / 2) / pw) * 100;
                              const cy =
                                ((bbox.y + bbox.height / 2) / ph) * 100;
                              const faceRatio = Math.max(
                                bbox.width / pw,
                                bbox.height / ph
                              );
                              const zoom = Math.min(
                                Math.max(1 / (faceRatio * 2.2), 1.2),
                                4
                              );
                              return (
                                <img
                                  alt={identity.name || t("unnamedPerson")}
                                  className="h-full w-full object-cover"
                                  src={toLocalMediaUrl(
                                    identity.coverThumbnailPath
                                  )}
                                  style={{
                                    objectPosition: `${cx}% ${cy}%`,
                                    transform: `scale(${zoom})`,
                                    transformOrigin: `${cx}% ${cy}%`,
                                  }}
                                />
                              );
                            }
                            return (
                              <img
                                alt={identity.name || t("unnamedPerson")}
                                className="h-full w-full object-cover"
                                src={toLocalMediaUrl(
                                  identity.coverThumbnailPath
                                )}
                              />
                            );
                          })()
                        ) : (
                          <div className="flex h-full w-full items-center justify-center">
                            <User className="h-12 w-12 text-muted-foreground/30" />
                          </div>
                        )}
                      </div>
                      <div className="p-3">
                        {editingId === identity.id ? (
                          <input
                            autoFocus
                            className="w-full truncate rounded-[3px] border border-primary/40 bg-background px-1 py-px font-[510] text-[13px] text-foreground outline-none"
                            onBlur={() => handleRename(identity.id)}
                            onChange={(e) => setNameInput(e.target.value)}
                            onCompositionEnd={(e) => {
                              composingRef.current = false;
                              setNameInput((e.target as HTMLInputElement).value);
                            }}
                            onCompositionStart={() => {
                              composingRef.current = true;
                            }}
                            onFocus={(e) => e.target.select()}
                            onKeyDown={(e) => {
                              if (composingRef.current) return;
                              if (e.key === "Enter") {
                                e.preventDefault();
                                handleRename(identity.id);
                              }
                              if (e.key === "Escape") {
                                e.preventDefault();
                                cancelEditing();
                              }
                            }}
                            value={nameInput}
                          />
                        ) : (
                          <h3
                            className="truncate font-[510] text-[13px] text-foreground cursor-pointer hover:text-primary transition-colors"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              startEditing(identity.id, identity.name);
                            }}
                          >
                            {identity.name || t("unnamedPerson")}
                          </h3>
                        )}
                        <p className="mt-0.5 text-[11px] text-muted-foreground/70">
                          {identity.faceCount} {t("photos")}
                        </p>
                      </div>
                    </Link>
                    <button
                      className="absolute top-2 right-2 flex h-7 w-7 items-center justify-center rounded-[4px] bg-black/60 text-white opacity-0 transition-opacity hover:bg-destructive group-hover:opacity-100"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        handleDeleteIdentity(identity.id, identity.name);
                      }}
                      title={t("deletePerson")}
                      type="button"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <ConfirmDialog
        confirmText={t("delete")}
        description={t("deletePersonDescription", {
          name: confirmDelete?.name || t("unnamedPerson"),
        })}
        destructive
        onCancel={() => setConfirmDelete(null)}
        onConfirm={performDeleteIdentity}
        open={confirmDelete !== null}
        title={t("deletePersonTitle")}
      />
    </div>
  );
}

function PeopleLayout() {
  const childMatch = useMatch({
    from: "/people/$identityId",
    shouldThrow: false,
  });
  if (childMatch) {
    return <Outlet />;
  }
  return <PeoplePage />;
}

export const Route = createFileRoute("/people" as const)({
  component: PeopleLayout,
});
