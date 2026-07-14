import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createFileRoute,
  Outlet,
  useMatch,
  useNavigate,
} from "@tanstack/react-router";
import {
  ArrowLeft,
  Check,
  Merge,
  Pencil,
  Play,
  RefreshCw,
  Trash2,
  User,
  X,
} from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { RouteError } from "@/components/RouteError";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useRouteScrollRestoration } from "@/hooks/useRouteScrollRestoration";
import { ipc } from "@/ipc/manager";
import { toLocalMediaUrl } from "@/utils/local-media-url";

interface FaceIdentity {
  coverBbox: { x: number; y: number; width: number; height: number } | null;
  coverPhotoHeight: number | null;
  coverPhotoPath: string | null;
  coverPhotoWidth: number | null;
  coverThumbnailPath: string | null;
  createdAt: number;
  faceCount: number;
  id: number;
  name: string | null;
  representativePhotoId: number | null;
}

// Person cover image with intersection-observer lazy loading + fade-in + error fallback
const PersonCoverImage = memo(function PersonCoverImage({
  identity,
}: {
  identity: FaceIdentity;
}) {
  const { t } = useTranslation();
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const imgRef = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);

  // IntersectionObserver：卡片进入视口后才加载图片
  useEffect(() => {
    const el = imgRef.current;
    if (!el) {
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setInView(true);
          observer.disconnect();
        }
      },
      { rootMargin: "400px" }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const src = identity.coverThumbnailPath || identity.coverPhotoPath;
  const bbox = identity.coverBbox;
  const pw = identity.coverPhotoWidth;
  const ph = identity.coverPhotoHeight;

  if (!src) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-muted">
        <User className="h-12 w-12 text-muted-foreground/30" />
      </div>
    );
  }

  const imgStyle: React.CSSProperties = {
    objectFit: "cover" as const,
  };

  if (bbox && pw && ph) {
    const cx = ((bbox.x + bbox.width / 2) / pw) * 100;
    const cy = ((bbox.y + bbox.height / 2) / ph) * 100;
    const faceRatio = Math.max(bbox.width / pw, bbox.height / ph);
    const zoom = Math.min(Math.max(1 / (faceRatio * 2.2), 1.2), 4);
    imgStyle.objectPosition = `${cx}% ${cy}%`;
    imgStyle.transform = `scale(${zoom})`;
    imgStyle.transformOrigin = `${cx}% ${cy}%`;
  }

  return (
    <div className="h-full w-full bg-muted" ref={imgRef}>
      {inView && !error && (
        <img
          alt={identity.name || t("unnamedPerson")}
          className={`h-full w-full object-cover transition-opacity duration-500 ${
            loaded ? "opacity-100" : "opacity-0"
          }`}
          decoding="async"
          loading="lazy"
          onError={() => setError(true)}
          onLoad={() => setLoaded(true)}
          src={toLocalMediaUrl(src)}
          style={imgStyle}
        />
      )}
      {error && (
        <div className="flex h-full w-full items-center justify-center">
          <User className="h-12 w-12 text-muted-foreground/30" />
        </div>
      )}
    </div>
  );
});

// Person card (memo'd)
const PersonCard = memo(function PersonCard({
  identity,
  isSelected,
  selectMode,
  editingId,
  nameInput,
  composingRef,
  onToggleSelect,
  onStartEdit,
  onCancelEdit,
  onRename,
  onNameInputChange,
  onNameInputCompositionEnd,
  onNameInputCompositionStart,
  onDelete,
}: {
  identity: FaceIdentity;
  isSelected: boolean;
  selectMode: boolean;
  editingId: number | null;
  nameInput: string;
  composingRef: React.MutableRefObject<boolean>;
  onToggleSelect: (id: number) => void;
  onStartEdit: (id: number, currentName: string | null) => void;
  onCancelEdit: () => void;
  onRename: (id: number) => void;
  onNameInputChange: (value: string) => void;
  onNameInputCompositionEnd: (
    e: React.CompositionEvent<HTMLInputElement>
  ) => void;
  onNameInputCompositionStart: () => void;
  onDelete: (id: number, name: string | null) => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const isEditing = editingId === identity.id;

  const handleClick = () => {
    if (selectMode) {
      onToggleSelect(identity.id);
    } else {
      navigate({
        to: "/people/$identityId",
        params: { identityId: identity.id.toString() },
      });
    }
  };

  return (
    <div
      className={`group relative cursor-pointer overflow-hidden rounded-[8px] border bg-card transition-colors ${
        isSelected
          ? "border-primary ring-2 ring-primary/30"
          : "border-border hover:border-primary/30"
      }`}
      onClick={handleClick}
    >
      <div className="aspect-square overflow-hidden">
        <PersonCoverImage identity={identity} />
      </div>
      <div className="p-3">
        {isEditing ? (
          <input
            autoFocus
            className="w-full truncate rounded-[3px] border border-primary/40 bg-background px-1 py-px font-medium text-[13px] text-foreground outline-none"
            onBlur={() => onRename(identity.id)}
            onChange={(e) => onNameInputChange(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onCompositionEnd={(e) => {
              onNameInputCompositionEnd(e);
            }}
            onCompositionStart={onNameInputCompositionStart}
            onFocus={(e) => e.target.select()}
            onKeyDown={(e) => {
              if (composingRef.current) {
                return;
              }
              if (e.key === "Enter") {
                e.preventDefault();
                onRename(identity.id);
              }
              if (e.key === "Escape") {
                e.preventDefault();
                onCancelEdit();
              }
            }}
            value={nameInput}
          />
        ) : (
          <h3 className="truncate font-medium text-[13px] text-foreground">
            {identity.name || t("unnamedPerson")}
          </h3>
        )}
        <p className="mt-0.5 text-[11px] text-muted-foreground/70">
          {identity.faceCount} {t("photos")}
        </p>
      </div>
      {isSelected && (
        <div className="pointer-events-none absolute top-2 left-2 flex h-6 w-6 items-center justify-center rounded-full bg-primary text-white">
          <Check className="h-3.5 w-3.5" />
        </div>
      )}
      {!selectMode && (
        <div className="absolute top-2 right-2 flex gap-1 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                aria-label={t("renamePerson")}
                className="flex h-7 w-7 items-center justify-center rounded-[5px] bg-black/65 text-white transition-colors hover:bg-primary"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onStartEdit(identity.id, identity.name);
                }}
                type="button"
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent>{t("renamePerson")}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                aria-label={t("deletePerson")}
                className="flex h-7 w-7 items-center justify-center rounded-[5px] bg-black/65 text-white transition-colors hover:bg-destructive"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onDelete(identity.id, identity.name);
                }}
                type="button"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent>{t("deletePerson")}</TooltipContent>
          </Tooltip>
        </div>
      )}
    </div>
  );
});

// Skeleton card placeholder
function SkeletonCard() {
  return (
    <div className="overflow-hidden rounded-[8px] border border-border bg-card">
      <div className="aspect-square animate-pulse bg-muted" />
      <div className="space-y-1.5 p-3">
        <div className="h-4 w-3/4 animate-pulse rounded-[3px] bg-muted" />
        <div className="h-3 w-1/3 animate-pulse rounded-[3px] bg-muted" />
      </div>
    </div>
  );
}

// Dynamic skeleton count to fill viewport
function useSkeletonCount(): number {
  const [count, setCount] = useState(12);
  useEffect(() => {
    function calc() {
      // 160px 最小列宽 + 16px gap，估算填满视口所需数量
      const colWidth = 160 + 16;
      const cols = Math.max(2, Math.floor(window.innerWidth / colWidth));
      const rows = Math.max(2, Math.ceil(window.innerHeight / 220));
      setCount(cols * rows);
    }
    calc();
    window.addEventListener("resize", calc);
    return () => window.removeEventListener("resize", calc);
  }, []);
  return count;
}

// PeoplePage
function PeoplePage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const scrollRef = useRef<HTMLDivElement>(null);
  useRouteScrollRestoration(scrollRef, { getRouteKey: () => "people-list" });

  // TanStack Query data fetching
  const {
    data: identities = [],
    isLoading,
    isError,
  } = useQuery({
    queryKey: ["faces", "identities"],
    queryFn: async () => {
      const result = await ipc.client.faces.listFaceIdentities({});
      return result as FaceIdentity[];
    },
    staleTime: 30_000,
  });

  // Face detection state
  const [detecting, setDetecting] = useState(false);
  const [progress, setProgress] = useState("");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadIdentities = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["faces", "identities"] });
  }, [queryClient]);

  const startPolling = useCallback(() => {
    if (pollRef.current) {
      return;
    }
    pollRef.current = setInterval(async () => {
      try {
        const p = (await ipc.client.faces.getDetectionProgress({})) as {
          phase: string;
          processed: number;
          total?: number;
        };
        if (p.phase === "complete") {
          setProgress(t("detectionCompleteCount", { count: p.processed }));
          if (pollRef.current) {
            clearInterval(pollRef.current);
            pollRef.current = null;
          }
          setDetecting(false);
          loadIdentities();
        } else if (p.phase === "running") {
          setProgress(
            t("detectingFacesProgress", {
              processed: p.processed,
              total: p.total,
            })
          );
        } else {
          if (pollRef.current) {
            clearInterval(pollRef.current);
            pollRef.current = null;
          }
          setDetecting(false);
          setProgress("");
        }
      } catch {
        if (pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
        setDetecting(false);
      }
    }, 2000);
  }, [loadIdentities, t]);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  // 挂载时检查是否已有检测在运行
  useEffect(() => {
    ipc.client.faces
      .getDetectionProgress({})
      .then((p: unknown) => {
        const progress = p as {
          phase: string;
          processed: number;
          total?: number;
        };
        if (progress.phase === "running") {
          setDetecting(true);
          setProgress(
            t("detectingFacesProgress", {
              processed: progress.processed,
              total: progress.total,
            })
          );
          startPolling();
        }
      })
      .catch(() => {
        /* ignore */
      });
    return () => {
      stopPolling();
    };
  }, [startPolling, stopPolling, t]);

  async function handleStartDetection(rescan = false) {
    setDetecting(true);
    setProgress(
      rescan ? t("restartingFaceDetection") : t("startingFaceDetection")
    );
    try {
      const result = (await ipc.client.faces.startFaceDetection({
        rescan,
      })) as { started: boolean; photoCount?: number; message?: string };
      if (result.started) {
        setProgress(t("detectingFacesCount", { count: result.photoCount }));
        startPolling();
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
        setProgress(
          t("reclusterCompleteCount", { count: result.identityCount })
        );
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

  // Select / merge state
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState<{
    id: number;
    name: string | null;
  } | null>(null);

  // Inline rename state
  const [editingId, setEditingId] = useState<number | null>(null);
  const [nameInput, setNameInput] = useState("");
  const [personFilter, setPersonFilter] = useState<
    "all" | "unnamed" | "named"
  >("all");
  const composingRef = useRef(false);

  const unnamedCount = useMemo(
    () => identities.filter((identity) => !identity.name?.trim()).length,
    [identities]
  );
  const filteredIdentities = useMemo(() => {
    if (personFilter === "unnamed") {
      return identities.filter((identity) => !identity.name?.trim());
    }
    if (personFilter === "named") {
      return identities.filter((identity) => identity.name?.trim());
    }
    return identities;
  }, [identities, personFilter]);

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

  async function handleMerge() {
    if (selected.size < 2) {
      return;
    }
    const ids = [...selected];
    const sorted = ids
      .map((id) => identities.find((i) => i.id === id)!)
      .filter(Boolean)
      .sort((a, b) => b.faceCount - a.faceCount);
    const targetId = sorted[0].id;
    const sourceIds = ids.filter((id) => id !== targetId);

    // Snapshot for rollback
    const previousData = queryClient.getQueryData<FaceIdentity[]>([
      "faces",
      "identities",
    ]);

    try {
      // Optimistic update: remove source identities immediately (no flash)
      const mergedFaceCount = sorted.reduce((sum, i) => sum + i.faceCount, 0);
      queryClient.setQueryData<FaceIdentity[]>(["faces", "identities"], (old) =>
        old
          ?.filter((i) => !sourceIds.includes(i.id))
          .map((i) =>
            i.id === targetId ? { ...i, faceCount: mergedFaceCount } : i
          )
      );

      setSelectMode(false);
      setSelected(new Set());

      await ipc.client.faces.mergeIdentities({ targetId, sourceIds });
      // Background refetch to sync cover bbox + other server-side updates
      queryClient.invalidateQueries({ queryKey: ["faces", "identities"] });
    } catch {
      // Rollback on failure
      if (previousData) {
        queryClient.setQueryData(["faces", "identities"], previousData);
      }
      toast.error(t("mergePeopleFailed"));
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

    const previousData = queryClient.getQueryData<FaceIdentity[]>([
      "faces",
      "identities",
    ]);

    try {
      // Optimistic update: remove from list immediately (no flash)
      queryClient.setQueryData<FaceIdentity[]>(["faces", "identities"], (old) =>
        old?.filter((i) => i.id !== id)
      );

      await ipc.client.faces.deleteFaceIdentity({ id });
      // Background refetch to stay in sync
      queryClient.invalidateQueries({ queryKey: ["faces", "identities"] });
    } catch {
      if (previousData) {
        queryClient.setQueryData(["faces", "identities"], previousData);
      }
      toast.error(t("deletePersonFailed"));
    }
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
      // 乐观更新缓存
      queryClient.setQueryData<FaceIdentity[]>(["faces", "identities"], (old) =>
        old?.map((i) => (i.id === id ? { ...i, name: newName || null } : i))
      );
    } catch {
      toast.error(t("personRenameFailed"));
    } finally {
      setEditingId((current) => (current === id ? null : current));
    }
  }

  // Skeleton count
  const skeletonCount = useSkeletonCount();

  // Render
  const showContent = !(isLoading || isError);

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Header */}
      <div className="flex items-center justify-between border-border border-b px-6 py-4">
        <div className="flex items-center gap-3">
          <button
            className="flex h-8 w-8 items-center justify-center rounded-[6px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
            onClick={() => navigate({ to: "/" })}
            type="button"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div>
            <h1 className="font-semibold text-[24px] text-foreground tracking-tight">
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
                className="flex items-center gap-1.5 rounded-[6px] bg-primary px-4 py-1.5 font-medium text-[13px] text-white transition-opacity hover:opacity-90 disabled:opacity-40"
                disabled={selected.size < 2}
                onClick={handleMerge}
                type="button"
              >
                <Merge className="h-3.5 w-3.5" />
                {t("mergeAsSamePerson")}
              </button>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    className="flex h-8 w-8 items-center justify-center rounded-[6px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
                    onClick={exitSelectMode}
                    type="button"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>{t("clearSelection")}</TooltipContent>
              </Tooltip>
            </>
          ) : (
            <>
              {identities.length > 1 && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      className="flex items-center gap-1.5 rounded-[6px] border border-border px-3 py-1.5 font-medium text-[13px] text-foreground transition-colors hover:bg-foreground/5 disabled:opacity-40"
                      disabled={detecting}
                      onClick={() => setSelectMode(true)}
                      type="button"
                    >
                      <Merge className="h-3.5 w-3.5" />
                      {t("mergePeople")}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>{t("mergePeopleHint")}</TooltipContent>
                </Tooltip>
              )}
              {identities.length > 0 && (
                <>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        className="flex items-center gap-1.5 rounded-[6px] border border-border px-3 py-1.5 font-medium text-[13px] text-foreground transition-colors hover:bg-foreground/5 disabled:opacity-40"
                        disabled={detecting}
                        onClick={handleRecluster}
                        type="button"
                      >
                        <RefreshCw className="h-3.5 w-3.5" />
                        {t("reclusterFaces")}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>{t("reclusterFacesHint")}</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        className="flex items-center gap-1.5 rounded-[6px] border border-border px-3 py-1.5 font-medium text-[13px] text-foreground transition-colors hover:bg-foreground/5 disabled:opacity-40"
                        disabled={detecting}
                        onClick={() => handleStartDetection(true)}
                        type="button"
                      >
                        <RefreshCw className="h-3.5 w-3.5" />
                        {t("rescan")}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>{t("rescanFacesHint")}</TooltipContent>
                  </Tooltip>
                </>
              )}
              <button
                className="flex items-center gap-1.5 rounded-[6px] bg-primary px-4 py-1.5 font-medium text-[13px] text-white transition-opacity hover:opacity-90 disabled:opacity-40"
                disabled={detecting}
                onClick={() => handleStartDetection(false)}
                type="button"
              >
                <Play className="h-3.5 w-3.5" />
                {detecting ? t("faceDetecting") : t("startFaceDetection")}
              </button>
            </>
          )}
        </div>
      </div>

      {/* Progress bar */}
      {progress && (
        <div className="border-border border-b bg-primary/5 px-6 py-2 text-[12px] text-primary">
          {detecting && (
            <LoadingSpinner className="mr-2 inline-block" size="xs" />
          )}
          {progress}
        </div>
      )}

      {/* Grid area */}
      <div className="flex-1 overflow-y-auto p-6" ref={scrollRef}>
        {showContent && identities.length > 0 && (
          <div className="mb-5 flex items-center justify-between gap-4">
            <div className="inline-flex rounded-[8px] border border-border bg-secondary p-1">
              {(
                [
                  ["all", t("peopleAll"), identities.length],
                  ["unnamed", t("peopleNeedsName"), unnamedCount],
                  [
                    "named",
                    t("peopleNamed"),
                    identities.length - unnamedCount,
                  ],
                ] as const
              ).map(([value, label, count]) => (
                <button
                  aria-pressed={personFilter === value}
                  className={`rounded-[6px] px-3 py-1.5 text-[12px] transition-colors ${
                    personFilter === value
                      ? "bg-card font-medium text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                  key={value}
                  onClick={() => setPersonFilter(value)}
                  type="button"
                >
                  {label}
                  <span className="ml-1.5 text-[10px] text-muted-foreground">
                    {count}
                  </span>
                </button>
              ))}
            </div>
            {unnamedCount > 0 && (
              <p className="text-[12px] text-muted-foreground">
                {t("peopleNeedsNameHint", { count: unnamedCount })}
              </p>
            )}
          </div>
        )}
        {/* 加载骨架屏：填满视口的卡片矩阵 */}
        {isLoading && (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-4">
            {Array.from({ length: skeletonCount }).map((_, i) => (
              <SkeletonCard key={`skel-${i}`} />
            ))}
          </div>
        )}

        {/* 错误状态 */}
        {isError && (
          <div className="flex h-64 flex-col items-center justify-center gap-3 text-muted-foreground/70">
            <User className="h-12 w-12 opacity-20" />
            <p className="text-[13px]">{t("loadFailedRetry")}</p>
            <button
              className="mt-2 rounded-[6px] bg-primary px-4 py-1.5 font-medium text-[13px] text-white transition-opacity hover:opacity-90"
              onClick={() =>
                queryClient.invalidateQueries({
                  queryKey: ["faces", "identities"],
                })
              }
              type="button"
            >
              {t("retry")}
            </button>
          </div>
        )}

        {/* 空状态 */}
        {showContent && identities.length === 0 && (
          <div className="flex h-64 flex-col items-center justify-center gap-3 text-muted-foreground/70">
            <User className="h-12 w-12 opacity-20" />
            <p className="text-[13px]">{t("noPeopleTitle")}</p>
            <p className="text-[11px] text-muted-foreground/70/60">
              {t("noPeopleDescription")}
            </p>
            <button
              className="mt-2 rounded-[6px] bg-primary px-4 py-1.5 font-medium text-[13px] text-white transition-opacity hover:opacity-90"
              disabled={detecting}
              onClick={() => handleStartDetection(false)}
              type="button"
            >
              {t("startFaceDetectionShort")}
            </button>
          </div>
        )}

        {/* 人物卡片网格 */}
        {showContent && identities.length > 0 && (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-4">
            {filteredIdentities.map((identity) => (
              <PersonCard
                composingRef={composingRef}
                editingId={editingId}
                identity={identity}
                isSelected={selected.has(identity.id)}
                key={identity.id}
                nameInput={nameInput}
                onCancelEdit={cancelEditing}
                onDelete={handleDeleteIdentity}
                onNameInputChange={setNameInput}
                onNameInputCompositionEnd={(e) => {
                  composingRef.current = false;
                  setNameInput((e.target as HTMLInputElement).value);
                }}
                onNameInputCompositionStart={() => {
                  composingRef.current = true;
                }}
                onRename={handleRename}
                onStartEdit={startEditing}
                onToggleSelect={toggleSelect}
                selectMode={selectMode}
              />
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
  errorComponent: RouteError,
});
