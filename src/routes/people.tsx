import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createFileRoute,
  Outlet,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";
import {
  ArrowLeft,
  Check,
  Ellipsis,
  EyeOff,
  FolderCog,
  Merge,
  Pencil,
  Play,
  RefreshCw,
  RotateCcw,
  Search,
  User,
  X,
} from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { faceActions } from "@/actions/faces";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import type { FaceCandidate } from "@/components/face-candidate-dialog";
import { FaceScanScopeDialog } from "@/components/face-scan-scope-dialog";
import { RouteError } from "@/components/RouteError";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useGlobalAiStatus } from "@/hooks/use-global-ai-status";
import { useFolders } from "@/hooks/useFolders";
import { useRouteScrollRestoration } from "@/hooks/useRouteScrollRestoration";
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

interface FaceScanScope {
  configured: boolean;
  folderIds: number[];
}

interface HiddenIdentity {
  coverPhotoPath: string | null;
  coverThumbnailPath: string | null;
  faceCount: number;
  id: number;
  name: string | null;
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
        // biome-ignore lint/a11y/noNoninteractiveElementInteractions: image load state drives the cover fallback
        <img
          alt={identity.name || t("unnamedPerson")}
          className={`h-full w-full object-cover transition-opacity duration-500 ${
            loaded ? "opacity-100" : "opacity-0"
          }`}
          decoding="async"
          height={identity.coverPhotoHeight ?? 320}
          loading="lazy"
          onError={() => setError(true)}
          onLoad={() => setLoaded(true)}
          src={toLocalMediaUrl(src)}
          style={imgStyle}
          width={identity.coverPhotoWidth ?? 320}
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
  onHide,
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
  onHide: (id: number, name: string | null) => void;
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

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) {
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      handleClick();
    }
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: the card contains nested action buttons
    <div
      aria-label={`${identity.name || t("unnamedPerson")}，${t("photosCount", { count: identity.faceCount })}`}
      className={`group relative cursor-pointer overflow-hidden rounded-[8px] border bg-card transition-colors ${
        isSelected
          ? "border-primary ring-2 ring-primary/30"
          : "border-border hover:border-primary/30"
      }`}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      role="button"
      tabIndex={0}
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
          <div className="flex min-w-0 items-center gap-2">
            <h3 className="min-w-0 flex-1 truncate font-medium text-[13px] text-foreground">
              {identity.name || t("unnamedPerson")}
            </h3>
            {!identity.name?.trim() && (
              <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] text-primary">
                {t("peopleNeedsName")}
              </span>
            )}
          </div>
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
                aria-label={t("hidePerson")}
                className="flex h-7 w-7 items-center justify-center rounded-[5px] bg-black/65 text-white transition-colors hover:bg-primary"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onHide(identity.id, identity.name);
                }}
                type="button"
              >
                <EyeOff className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent>{t("hidePerson")}</TooltipContent>
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
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: this page coordinates the existing people interactions
function PeoplePage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data: folders = [] } = useFolders();
  const scrollRef = useRef<HTMLDivElement>(null);
  useRouteScrollRestoration(scrollRef, { getRouteKey: () => "people-list" });
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [isToolbarScrolled, setIsToolbarScrolled] = useState(false);
  const [toolbarHeight, setToolbarHeight] = useState(0);

  // TanStack Query data fetching
  const {
    data: identities = [],
    isLoading,
    isError,
  } = useQuery({
    queryKey: ["faces", "identities"],
    queryFn: async () => {
      const result = await faceActions.listIdentities();
      return result as FaceIdentity[];
    },
    staleTime: 30_000,
  });
  const { data: scanScope, isLoading: isScanScopeLoading } = useQuery({
    queryKey: ["faces", "scan-scope"],
    queryFn: async () => (await faceActions.getScanScope()) as FaceScanScope,
    staleTime: 30_000,
  });
  const {
    data: hiddenIdentities = [],
    isError: isHiddenIdentitiesError,
    isLoading: isHiddenIdentitiesLoading,
  } = useQuery({
    queryKey: ["faces", "hidden-identities"],
    queryFn: async () =>
      (await faceActions.listHiddenIdentities()) as HiddenIdentity[],
    staleTime: 30_000,
  });
  const { data: reviewQueue = [] } = useQuery({
    queryKey: ["faces", "review-queue", "pending"],
    queryFn: async () =>
      (await faceActions.listReviewQueue({
        status: "pending",
        limit: 500,
      })) as FaceCandidate[],
    staleTime: 0,
  });

  // 工具栏高度会随 nav 内容（搜索框随数据出现）变化；数据加载后重新测量，
  // 确保滚动容器 paddingTop 始终不小于工具栏实际高度，避免遮挡卡片。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 数据长度作为重测触发器，函数体内不直接使用
  useLayoutEffect(() => {
    const element = toolbarRef.current;
    if (!element) {
      return;
    }
    const updateHeight = () => setToolbarHeight(element.offsetHeight);
    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(element);
    return () => observer.disconnect();
  }, [identities.length, hiddenIdentities.length]);

  // Face detection state — progress/phase is driven by the global AI status hook
  const { phase: globalAiPhase } = useGlobalAiStatus();
  const detecting = globalAiPhase === "face-detection";
  const [scopeDialogOpen, setScopeDialogOpen] = useState(false);
  const [pendingScanAfterScope, setPendingScanAfterScope] = useState<
    "incremental" | "rescan" | null
  >(null);
  const [confirmRescan, setConfirmRescan] = useState(false);
  const [confirmModelReset, setConfirmModelReset] = useState(false);
  const [confirmClearFaceData, setConfirmClearFaceData] = useState(false);
  const [resettingFaceData, setResettingFaceData] = useState(false);
  const [moreActionsOpen, setMoreActionsOpen] = useState(false);

  const loadIdentities = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["faces", "identities"] });
  }, [queryClient]);

  // Listen for the face-detection completion event and surface a summary toast.
  // Progress (phase) itself is derived from the global AI status hook.
  useEffect(() => {
    function handleFaceDetectionDone(e: MessageEvent) {
      const payload = e.data as {
        channel?: string;
        error?: string;
        totalFaces?: number;
      };
      if (payload?.channel !== "face-detection-done") {
        return;
      }
      if (payload.error) {
        toast.error(t("faceDetectionFailed"));
        return;
      }
      // 完整摘要（facesDetected/invalidFaces/failedPhotos）仅在 phase==="complete" 时返回
      faceActions
        .getDetectionProgress()
        .then((p) => {
          const progress = p as {
            failedPhotos?: number;
            facesDetected?: number;
            invalidFaces?: number;
            phase: string;
            processed: number;
            total?: number;
          };
          if (progress.phase === "complete") {
            toast.success(
              t("faceDetectionCompleteSummary", {
                processed: progress.processed,
                total: progress.total ?? 0,
                faces: progress.facesDetected ?? 0,
                invalid: progress.invalidFaces ?? 0,
                failed: progress.failedPhotos ?? 0,
              })
            );
            loadIdentities();
          }
        })
        .catch(() => {
          /* ignore */
        });
    }
    window.addEventListener("message", handleFaceDetectionDone);
    return () => window.removeEventListener("message", handleFaceDetectionDone);
  }, [loadIdentities, t]);

  async function handleStartDetection(rescan = false) {
    try {
      const result = (await faceActions.startDetection(rescan)) as {
        started: boolean;
        photoCount?: number;
        message?: string;
        requiresScope?: boolean;
        requiresModelReset?: boolean;
      };
      if (result.requiresModelReset) {
        // Stored vectors are from a different model kind — ask before resetting.
        setConfirmModelReset(true);
        return;
      }
      if (result.started) {
        // 进度由全局进度条展示，无页面横幅
      } else if (result.requiresScope) {
        setPendingScanAfterScope(rescan ? "rescan" : "incremental");
        setScopeDialogOpen(true);
      } else {
        toast.error(result.message || t("startFailed"));
      }
    } catch {
      toast.error(t("startFaceDetectionFailed"));
    }
  }

  function requestDetection(rescan: boolean) {
    if (!scanScope?.configured) {
      setPendingScanAfterScope(rescan ? "rescan" : "incremental");
      setScopeDialogOpen(true);
      return;
    }
    if (rescan) {
      setConfirmRescan(true);
    } else {
      handleStartDetection(false);
    }
  }

  async function saveScanScope(folderIds: number[]) {
    try {
      const saved = (await faceActions.setScanScope(
        folderIds
      )) as FaceScanScope;
      queryClient.setQueryData(["faces", "scan-scope"], saved);
      setScopeDialogOpen(false);
      const pending = pendingScanAfterScope;
      setPendingScanAfterScope(null);
      toast.success(t("faceScanScopeSaved"));
      if (pending === "incremental") {
        await handleStartDetection(false);
      } else if (pending === "rescan") {
        setConfirmRescan(true);
      }
    } catch {
      toast.error(t("faceScanScopeSaveFailed"));
    }
  }

  async function handleRestoreHidden(id: number) {
    try {
      await faceActions.restoreHiddenIdentity(id);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["faces", "identities"] }),
        queryClient.invalidateQueries({
          queryKey: ["faces", "hidden-identities"],
        }),
      ]);
      toast.success(t("toastPersonRestored"));
    } catch {
      toast.error(t("toastPersonRestoreFailed"));
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
    "all" | "hidden" | "named" | "unnamed"
  >("all");
  const [personQuery, setPersonQuery] = useState("");
  const composingRef = useRef(false);

  const unnamedCount = useMemo(
    () => identities.filter((identity) => !identity.name?.trim()).length,
    [identities]
  );
  const filteredIdentities = useMemo(() => {
    const query = personQuery.trim().toLocaleLowerCase();
    return identities.filter((identity) => {
      const matchesFilter =
        personFilter === "all" ||
        (personFilter === "unnamed" && !identity.name?.trim()) ||
        (personFilter === "named" && Boolean(identity.name?.trim()));
      const matchesQuery =
        !query || identity.name?.toLocaleLowerCase().includes(query);
      return matchesFilter && matchesQuery;
    });
  }, [identities, personFilter, personQuery]);
  const filteredHiddenIdentities = useMemo(() => {
    const query = personQuery.trim().toLocaleLowerCase();
    return hiddenIdentities.filter(
      (identity) => !query || identity.name?.toLocaleLowerCase().includes(query)
    );
  }, [hiddenIdentities, personQuery]);

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
      .map((id) => identities.find((identity) => identity.id === id))
      .filter((identity): identity is FaceIdentity => identity !== undefined)
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

      await faceActions.merge(targetId, sourceIds);
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

      await faceActions.hideIdentity(id);
      // Background refetch to stay in sync
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["faces", "identities"] }),
        queryClient.invalidateQueries({
          queryKey: ["faces", "hidden-identities"],
        }),
      ]);
    } catch {
      if (previousData) {
        queryClient.setQueryData(["faces", "identities"], previousData);
      }
      toast.error(t("hidePersonFailed"));
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
      await faceActions.updateIdentity(id, { name: newName });
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
    <div className="flex h-full min-w-0 flex-col bg-background">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-border border-b px-4 py-3 sm:px-6 sm:py-4">
        <div className="flex min-w-0 items-center gap-3">
          <button
            className="flex h-8 w-8 items-center justify-center rounded-[6px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
            onClick={() => navigate({ to: "/" })}
            type="button"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div className="min-w-0">
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
        <div className="flex max-w-full flex-wrap items-center justify-end gap-2">
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
              <Button
                disabled={detecting || isScanScopeLoading}
                onClick={() => requestDetection(false)}
                size="lg"
                type="button"
              >
                <Play className="h-3.5 w-3.5" />
                {detecting ? t("faceDetecting") : t("scanNewPhotos")}
              </Button>
              <Popover onOpenChange={setMoreActionsOpen} open={moreActionsOpen}>
                <PopoverTrigger asChild>
                  <Button
                    aria-label={t("moreActions")}
                    disabled={detecting}
                    size="icon-lg"
                    variant="ghost"
                  >
                    <Ellipsis />
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-56 gap-1 p-1.5">
                  {identities.length > 1 && (
                    <button
                      className="flex w-full items-center gap-2 rounded-[6px] px-2.5 py-2 text-left text-[12px] text-foreground hover:bg-muted"
                      onClick={() => {
                        setMoreActionsOpen(false);
                        setSelectMode(true);
                      }}
                      type="button"
                    >
                      <Merge className="h-3.5 w-3.5 text-muted-foreground" />
                      {t("mergePeople")}
                    </button>
                  )}
                  <button
                    className="flex w-full items-center gap-2 rounded-[6px] px-2.5 py-2 text-left text-[12px] text-foreground hover:bg-muted"
                    onClick={() => {
                      setMoreActionsOpen(false);
                      setPendingScanAfterScope(null);
                      setScopeDialogOpen(true);
                    }}
                    type="button"
                  >
                    <FolderCog className="h-3.5 w-3.5 text-muted-foreground" />
                    {t("faceScanScope")}
                  </button>
                  {identities.length > 0 && (
                    <>
                      <div className="my-1 border-border border-t" />
                      <button
                        className="flex w-full items-center gap-2 rounded-[6px] px-2.5 py-2 text-left text-[12px] text-foreground hover:bg-muted"
                        onClick={() => {
                          setMoreActionsOpen(false);
                          requestDetection(true);
                        }}
                        type="button"
                      >
                        <RefreshCw className="h-3.5 w-3.5 text-muted-foreground" />
                        {t("rescan")}
                      </button>
                      <div className="my-1 border-border border-t" />
                      <button
                        className="flex w-full items-center gap-2 rounded-[6px] px-2.5 py-2 text-left text-[12px] text-destructive hover:bg-destructive/10"
                        onClick={() => {
                          setMoreActionsOpen(false);
                          setConfirmClearFaceData(true);
                        }}
                        type="button"
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                        <span className="min-w-0">
                          <span className="block">{t("clearFaceData")}</span>
                          <span className="mt-0.5 block whitespace-normal text-[10px] text-muted-foreground leading-4">
                            {t("resetFaceDataMenuHint")}
                          </span>
                        </span>
                      </button>
                    </>
                  )}
                </PopoverContent>
              </Popover>
            </>
          )}
        </div>
      </div>

      {/* Grid area */}
      <div className="relative flex min-h-0 min-w-0 flex-1">
        <nav
          aria-label={t("people")}
          className={`page-toolbar absolute top-0 right-0 left-0 z-50 flex flex-wrap items-center justify-between gap-2 overflow-x-hidden border-b px-4 py-1.5 sm:px-6 ${isToolbarScrolled ? "is-scrolled" : ""}`}
          ref={toolbarRef}
        >
          <div className="inline-flex max-w-full shrink-0 overflow-x-auto rounded-[8px] border border-border bg-secondary p-1">
            {(
              [
                ["all", t("peopleAll"), identities.length],
                ["unnamed", t("peopleNeedsName"), unnamedCount],
                ["named", t("peopleNamed"), identities.length - unnamedCount],
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
            <button
              className="rounded-[6px] px-3 py-1.5 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
              onClick={() => navigate({ to: "/people/review" })}
              type="button"
            >
              {t("faceReview")}
              <span className="ml-1.5 text-[10px] text-muted-foreground">
                {reviewQueue.length}
              </span>
            </button>
            <button
              aria-pressed={personFilter === "hidden"}
              className={`rounded-[6px] px-3 py-1.5 text-[12px] transition-colors ${
                personFilter === "hidden"
                  ? "bg-card font-medium text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => setPersonFilter("hidden")}
              type="button"
            >
              {t("hiddenPeople")}
              <span className="ml-1.5 text-[10px] text-muted-foreground">
                {hiddenIdentities.length}
              </span>
            </button>
          </div>
          {(identities.length > 0 || hiddenIdentities.length > 0) && (
            <label className="relative w-full min-w-0 flex-1 sm:min-w-[200px] sm:max-w-[280px]">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                aria-label={t("peopleSearch")}
                className="h-8 w-full rounded-[6px] border border-input bg-card pr-8 pl-8 text-[12px] text-foreground outline-none placeholder:text-muted-foreground focus:border-primary"
                onChange={(event) => setPersonQuery(event.target.value)}
                placeholder={t("peopleSearch")}
                type="search"
                value={personQuery}
              />
            </label>
          )}
        </nav>
        <div
          className="min-w-0 flex-1 overflow-y-auto p-4 sm:p-6"
          onScroll={(event) => {
            setIsToolbarScrolled(event.currentTarget.scrollTop > 4);
          }}
          ref={scrollRef}
          style={{ paddingTop: toolbarHeight }}
        >
          {/* 加载骨架屏：填满视口的卡片矩阵 */}
          {isLoading && (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,190px),1fr))] gap-4">
              {Array.from({ length: skeletonCount }, (_, index) => index).map(
                (skeletonIndex) => (
                  <SkeletonCard key={`skel-${skeletonIndex}`} />
                )
              )}
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
          {showContent && personFilter === "hidden" && (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,220px),1fr))] gap-4">
              {isHiddenIdentitiesLoading &&
                ["one", "two", "three", "four"].map((key) => (
                  <SkeletonCard key={`hidden-skeleton-${key}`} />
                ))}
              {isHiddenIdentitiesError && (
                <div className="col-span-full flex flex-col items-center gap-3 py-12 text-center text-[13px] text-muted-foreground">
                  <span>{t("loadFailedRetry")}</span>
                  <button
                    className="rounded-md border border-border px-3 py-1.5 hover:bg-muted"
                    onClick={() =>
                      queryClient.invalidateQueries({
                        queryKey: ["faces", "hidden-identities"],
                      })
                    }
                    type="button"
                  >
                    {t("retry")}
                  </button>
                </div>
              )}
              {filteredHiddenIdentities.map((hiddenIdentity) => (
                <div
                  className="rounded-lg border border-border bg-card p-4"
                  key={hiddenIdentity.id}
                >
                  <div className="mb-3 aspect-square overflow-hidden rounded-md bg-muted">
                    {hiddenIdentity.coverThumbnailPath ||
                    hiddenIdentity.coverPhotoPath ? (
                      <img
                        alt={hiddenIdentity.name || t("unnamedPerson")}
                        className="h-full w-full object-cover"
                        height={320}
                        src={toLocalMediaUrl(
                          hiddenIdentity.coverThumbnailPath ||
                            hiddenIdentity.coverPhotoPath ||
                            ""
                        )}
                        width={320}
                      />
                    ) : (
                      <div className="flex h-full items-center justify-center">
                        <User className="h-10 w-10 text-muted-foreground/30" />
                      </div>
                    )}
                  </div>
                  <button
                    aria-label={t("hiddenViewPerson")}
                    className="font-medium text-[14px] text-foreground hover:text-primary"
                    onClick={() =>
                      navigate({
                        to: "/people/$identityId",
                        params: { identityId: String(hiddenIdentity.id) },
                      })
                    }
                    type="button"
                  >
                    {hiddenIdentity.name || t("unnamedPerson")}
                  </button>
                  <p className="mt-1 text-[12px] text-muted-foreground">
                    {t("photosCount", { count: hiddenIdentity.faceCount })}
                  </p>
                  <button
                    className="mt-3 rounded-md border border-border px-3 py-1.5 text-[12px] text-foreground hover:bg-foreground/5"
                    onClick={() => handleRestoreHidden(hiddenIdentity.id)}
                    type="button"
                  >
                    {t("restoreHiddenPerson")}
                  </button>
                </div>
              ))}
              {!(isHiddenIdentitiesLoading || isHiddenIdentitiesError) &&
                filteredHiddenIdentities.length === 0 && (
                  <p className="col-span-full py-12 text-center text-[13px] text-muted-foreground">
                    {t("noHiddenPeople")}
                  </p>
                )}
            </div>
          )}

          {showContent &&
            personFilter !== "hidden" &&
            identities.length === 0 && (
              <div className="flex h-64 flex-col items-center justify-center gap-3 text-muted-foreground/70">
                <User className="h-12 w-12 opacity-20" />
                <div className="max-w-full rounded-lg border border-primary/20 bg-primary/[0.04] px-4 py-3 text-center sm:max-w-md">
                  <p className="font-medium text-[13px] text-foreground">
                    {t("peopleEnableTitle")}
                  </p>
                  <p className="mt-1 text-[11px] text-muted-foreground leading-5">
                    {t("peopleEnableDescription")}
                  </p>
                </div>
                <p className="text-[13px]">{t("noPeopleTitle")}</p>
                <p className="text-[11px] text-muted-foreground/70/60">
                  {t("noPeopleDescription")}
                </p>
                <button
                  className="mt-2 rounded-[6px] bg-primary px-4 py-1.5 font-medium text-[13px] text-white transition-opacity hover:opacity-90"
                  disabled={detecting || isScanScopeLoading}
                  onClick={() => requestDetection(false)}
                  type="button"
                >
                  {t("startFaceDetectionShort")}
                </button>
              </div>
            )}

          {/* 人物卡片网格 */}
          {showContent &&
            personFilter !== "hidden" &&
            identities.length > 0 && (
              <>
                {filteredIdentities.length === 0 && (
                  <div className="flex h-48 flex-col items-center justify-center gap-2 text-center text-muted-foreground">
                    <Search className="h-8 w-8 opacity-30" />
                    <p className="text-[13px]">{t("peopleSearchEmpty")}</p>
                    <button
                      className="text-[12px] text-primary hover:underline"
                      onClick={() => {
                        setPersonFilter("all");
                        setPersonQuery("");
                      }}
                      type="button"
                    >
                      {t("clearFilters")}
                    </button>
                  </div>
                )}
                <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,190px),1fr))] gap-4">
                  {filteredIdentities.map((identity) => (
                    <PersonCard
                      composingRef={composingRef}
                      editingId={editingId}
                      identity={identity}
                      isSelected={selected.has(identity.id)}
                      key={identity.id}
                      nameInput={nameInput}
                      onCancelEdit={cancelEditing}
                      onHide={handleDeleteIdentity}
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
              </>
            )}
        </div>
      </div>

      <ConfirmDialog
        confirmText={t("hidePerson")}
        description={t("hidePersonDescription", {
          name: confirmDelete?.name || t("unnamedPerson"),
        })}
        onCancel={() => setConfirmDelete(null)}
        onConfirm={performDeleteIdentity}
        open={confirmDelete !== null}
        title={t("hidePersonTitle")}
      />
      <ConfirmDialog
        confirmText={t("confirmRescanFaces")}
        description={t("rescanFacesDescription")}
        onCancel={() => setConfirmRescan(false)}
        onConfirm={() => {
          setConfirmRescan(false);
          handleStartDetection(true);
        }}
        open={confirmRescan}
        title={t("rescanFacesTitle")}
      />
      <ConfirmDialog
        confirmText={t("confirmModelReset")}
        description={t("modelResetDescription")}
        destructive
        onCancel={() => setConfirmModelReset(false)}
        onConfirm={async () => {
          setConfirmModelReset(false);
          try {
            await faceActions.reset();
            toast.success(t("modelResetComplete"));
            loadIdentities();
            await handleStartDetection(false);
          } catch {
            toast.error(t("modelResetFailed"));
          }
        }}
        open={confirmModelReset}
        title={t("modelResetTitle")}
      />
      <ConfirmDialog
        confirmText={
          resettingFaceData ? t("resettingFaceData") : t("resetFaceDataConfirm")
        }
        description={t("resetFaceDataDescription")}
        destructive
        disabled={resettingFaceData}
        onCancel={() => {
          if (!resettingFaceData) {
            setConfirmClearFaceData(false);
          }
        }}
        onConfirm={async () => {
          setResettingFaceData(true);
          try {
            await faceActions.reset();
            await Promise.all([
              queryClient.invalidateQueries({
                queryKey: ["faces", "identities"],
              }),
              queryClient.invalidateQueries({
                queryKey: ["faces", "review-queue"],
              }),
              queryClient.invalidateQueries({
                queryKey: ["faces", "hidden-identities"],
              }),
            ]);
            setConfirmClearFaceData(false);
            toast.success(t("resetFaceDataSuccess"));
          } catch {
            toast.error(t("resetFaceDataFailed"));
          } finally {
            setResettingFaceData(false);
          }
        }}
        open={confirmClearFaceData}
        title={t("resetFaceDataTitle")}
      />
      <FaceScanScopeDialog
        folders={folders}
        initialFolderIds={scanScope?.folderIds ?? []}
        onClose={() => {
          setScopeDialogOpen(false);
          setPendingScanAfterScope(null);
        }}
        onSave={saveScanScope}
        open={scopeDialogOpen}
      />
    </div>
  );
}

function PeopleLayout() {
  const isChildRoute = useRouterState({
    select: (state) => state.location.pathname !== "/people",
  });
  if (isChildRoute) {
    return <Outlet />;
  }
  return <PeoplePage />;
}

export const Route = createFileRoute("/people" as const)({
  component: PeopleLayout,
  errorComponent: RouteError,
});
