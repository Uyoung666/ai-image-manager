import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, RotateCcw, Search, Trash2, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { FilterDropdown } from "@/components/filter-dropdown";
import { MasonryBackToTop } from "@/components/MasonryBackToTop";
import { RouteError } from "@/components/RouteError";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { usePhotoSelection } from "@/hooks/usePhotoSelection";
import { useRouteScrollRestoration } from "@/hooks/useRouteScrollRestoration";
import { ipc } from "@/ipc/manager";
import { queryClient } from "@/providers/QueryProvider";
import { toLocalMediaUrl } from "@/utils/local-media-url";

interface DeletedPhoto {
  deletedAt: number | null;
  filename: string;
  fileSize: number | null;
  folderId: number | null;
  folderName: string | null;
  height: number | null;
  id: number;
  path: string;
  thumbnailPath: string | null;
  width: number | null;
}

interface TrashOperationResult {
  failed: Array<{ code: string; id: number; message: string }>;
  restoredWithoutFolderIds?: number[];
  succeededIds: number[];
}

interface TrashListResult {
  items: DeletedPhoto[];
  nextCursor: { id: number; value: number | string } | null;
  totalBytes: number;
  totalCount: number;
  trashTotalBytes: number;
  trashTotalCount: number;
}

const TRASH_SKELETON_KEYS = Array.from(
  { length: 12 },
  (_, index) => `trash-skeleton-${index + 1}`
);
const TRASH_TOOLBAR_FALLBACK_HEIGHT = 48;
const TRASH_TOOLBAR_CONTENT_GAP = 16;
const TRASH_EXPIRY_FORMATTER = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: this route coordinates coupled desktop selection and batch-operation state
function TrashPage() {
  const { t } = useTranslation();
  const reduceMotion = useReducedMotion();
  const navigate = useNavigate();
  const routeKey = "trash";
  const [photos, setPhotos] = useState<DeletedPhoto[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState(false);
  const [nextCursor, setNextCursor] = useState<{
    id: number;
    value: number | string;
  } | null>(null);
  const [totalCount, setTotalCount] = useState(0);
  const [totalBytes, setTotalBytes] = useState(0);
  const [trashTotalCount, setTrashTotalCount] = useState(0);
  const [trashTotalBytes, setTrashTotalBytes] = useState(0);
  const [query, setQuery] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [sort, setSort] = useState<"deletedAt" | "name" | "size">("deletedAt");
  const [order, setOrder] = useState<"asc" | "desc">("desc");
  const [isToolbarScrolled, setIsToolbarScrolled] = useState(false);
  const [showBackToTop, setShowBackToTop] = useState(false);
  const [toolbarHeight, setToolbarHeight] = useState(0);
  const {
    selectedIds,
    handleSelect,
    handleMarqueeSelect,
    clearSelection,
    handleKeyboardSelect,
  } = usePhotoSelection(routeKey, photos);
  const [restoring, setRestoring] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmPermanent, setConfirmPermanent] = useState(false);
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const [previewPhoto, setPreviewPhoto] = useState<DeletedPhoto | null>(null);
  const [marquee, setMarquee] = useState<{
    startX: number;
    startY: number;
    x: number;
    y: number;
  } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const requestIdRef = useRef(0);
  const hasLoadedRef = useRef(false);
  const listParamsRef = useRef(`${query}:${sort}:${order}`);
  const marqueeRef = useRef<typeof marquee>(null);
  const marqueeFrameRef = useRef<number | null>(null);
  const marqueeJustCompleted = useRef(false);
  const [ctxMenu, setCtxMenu] = useState<{
    open: boolean;
    x: number;
    y: number;
    photoId: number | null;
    isBatch: boolean;
    selectionCount: number;
  }>({
    open: false,
    x: 0,
    y: 0,
    photoId: null,
    isBatch: false,
    selectionCount: 0,
  });

  const loadPhotos = useCallback(
    async (
      cursor: { id: number; value: number | string } | null = null,
      append = false
    ) => {
      const requestId = ++requestIdRef.current;
      if (append) {
        setLoadingMore(true);
        setLoadMoreError(false);
      } else if (hasLoadedRef.current) {
        setRefreshing(true);
        setRefreshError(false);
      } else {
        setLoading(true);
        setLoadError(false);
      }
      try {
        const result = (await ipc.client.photos.listDeletedPhotos({
          cursor,
          limit: 100,
          order,
          query,
          sort,
        })) as TrashListResult;
        if (requestId !== requestIdRef.current) {
          return;
        }
        setPhotos((current) =>
          append ? [...current, ...result.items] : result.items
        );
        setNextCursor(result.nextCursor);
        setTotalCount(result.totalCount);
        setTotalBytes(result.totalBytes);
        setTrashTotalCount(result.trashTotalCount);
        setTrashTotalBytes(result.trashTotalBytes);
        hasLoadedRef.current = true;
        window.dispatchEvent(
          new CustomEvent("trash-count-changed", {
            detail: result.trashTotalCount,
          })
        );
      } catch {
        if (requestId !== requestIdRef.current) {
          return;
        }
        if (append) {
          setLoadMoreError(true);
        } else if (hasLoadedRef.current) {
          setRefreshError(true);
        } else {
          setLoadError(true);
        }
      } finally {
        if (requestId === requestIdRef.current) {
          setLoading(false);
          setLoadingMore(false);
          setRefreshing(false);
        }
      }
    },
    [order, query, sort]
  );

  useEffect(() => {
    const listParams = `${query}:${sort}:${order}`;
    if (listParamsRef.current !== listParams) {
      scrollRef.current?.scrollTo({ top: 0 });
      listParamsRef.current = listParams;
    }
    clearSelection();
    loadPhotos(null, false);
  }, [loadPhotos, clearSelection, order, query, sort]);

  useEffect(
    () => () => {
      requestIdRef.current += 1;
    },
    []
  );

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(searchInput.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    function focusSearch(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    }
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);

  // 集成路由滚动位置管理（使用 elementFromPoint O(1) 锚点，比 querySelectorAll 更高效）
  useRouteScrollRestoration(scrollRef, {
    getRouteKey: () => routeKey,
    getCurrentAnchor: () => {
      const el = scrollRef.current;
      if (!el || photos.length === 0) {
        return null;
      }
      // 用 elementFromPoint O(1) 替代 querySelectorAll O(n)，避免每帧全量 DOM 遍历
      const containerRect = el.getBoundingClientRect();
      const sampleY = containerRect.top + 40; // 从视口顶部向下 40px 取样（跳过 padding）
      const sampleX = containerRect.left + containerRect.width / 2;
      const element = document.elementFromPoint(sampleX, sampleY);
      const card = element?.closest("[data-photo-id]") as HTMLElement | null;
      if (!card) {
        return null;
      }
      const id = Number(card.dataset.photoId);
      if (!id) {
        return null;
      }
      const cardRect = card.getBoundingClientRect();
      const cardTopInContainer =
        cardRect.top - containerRect.top + el.scrollTop;
      return {
        itemId: id,
        offsetFromTop: el.scrollTop - cardTopInContainer,
        offsetRatio: 0,
      };
    },
    restoreFromAnchor: (anchorItemId: number) => {
      const el = scrollRef.current;
      if (!el) {
        return null;
      }
      const card = el.querySelector(`[data-photo-id="${anchorItemId}"]`);
      if (!card) {
        return null;
      }
      const cardRect = card.getBoundingClientRect();
      const containerRect = el.getBoundingClientRect();
      return cardRect.top - containerRect.top + el.scrollTop;
    },
  });

  // Re-measure when the conditional toolbar appears after loading completes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: toolbar visibility changes are intentional re-measure triggers
  useLayoutEffect(() => {
    const element = toolbarRef.current;
    if (!element) {
      setToolbarHeight(0);
      return;
    }
    const updateHeight = () =>
      setToolbarHeight(element.offsetHeight || TRASH_TOOLBAR_FALLBACK_HEIGHT);
    updateHeight();
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(updateHeight);
    observer.observe(element);
    return () => observer.disconnect();
  }, [loading, query, trashTotalCount]);

  function toggleSelect(id: number, e: React.MouseEvent) {
    handleSelect(id, e);
  }

  function selectAll() {
    if (selectedIds.size === photos.length) {
      clearSelection();
    } else {
      handleMarqueeSelect(new Set(photos.map((p) => p.id)));
    }
  }

  async function handleRestore() {
    if (selectedIds.size === 0) {
      return;
    }
    setRestoring(true);
    try {
      const result = (await ipc.client.photos.restorePhotos({
        ids: [...selectedIds],
      })) as TrashOperationResult;
      if (result.succeededIds.length > 0) {
        toast.success(
          t("restoredPhotosCount", { count: result.succeededIds.length })
        );
      }
      if ((result.restoredWithoutFolderIds?.length ?? 0) > 0) {
        toast.warning(
          t("restoredWithoutFolderWarning", {
            count: result.restoredWithoutFolderIds?.length ?? 0,
          })
        );
      }
      if (result.failed.length > 0) {
        toast.warning(
          t("trashOperationPartial", { count: result.failed.length })
        );
        handleMarqueeSelect(
          new Set(result.failed.map((failure) => failure.id))
        );
      } else {
        clearSelection();
      }
      queryClient.invalidateQueries({
        queryKey: ["photos"],
        refetchType: "active",
      });
      queryClient.invalidateQueries({ queryKey: ["folders"] });
      await loadPhotos(null, false);
    } catch {
      toast.error(t("restoreFailed"));
    } finally {
      setRestoring(false);
    }
  }

  async function performPermanentDelete() {
    setConfirmPermanent(false);
    setDeleting(true);
    try {
      const result = (await ipc.client.photos.permanentlyDeletePhotos({
        ids: [...selectedIds],
      })) as TrashOperationResult;
      if (result.succeededIds.length > 0) {
        toast.success(
          t("movedToSystemTrashCount", { count: result.succeededIds.length })
        );
      }
      if (result.failed.length > 0) {
        toast.warning(
          t("trashOperationPartial", { count: result.failed.length })
        );
        handleMarqueeSelect(
          new Set(result.failed.map((failure) => failure.id))
        );
      } else {
        clearSelection();
      }
      queryClient.invalidateQueries({ queryKey: ["folders"] });
      await loadPhotos(null, false);
    } catch {
      toast.error(t("deleteFailed"));
    } finally {
      setDeleting(false);
    }
  }

  async function performEmptyTrash() {
    setConfirmEmpty(false);
    setDeleting(true);
    try {
      const result =
        (await ipc.client.photos.emptyTrash()) as TrashOperationResult;
      if (result.succeededIds.length > 0) {
        toast.success(
          t("movedToSystemTrashCount", { count: result.succeededIds.length })
        );
      }
      if (result.failed.length > 0) {
        toast.warning(
          t("trashOperationPartial", { count: result.failed.length })
        );
        handleMarqueeSelect(
          new Set(result.failed.map((failure) => failure.id))
        );
      } else {
        clearSelection();
      }
      queryClient.invalidateQueries({ queryKey: ["folders"] });
      await loadPhotos(null, false);
    } catch {
      toast.error(t("emptyTrashFailed"));
    } finally {
      setDeleting(false);
    }
  }

  function handlePermanentDelete() {
    if (selectedIds.size === 0) {
      return;
    }
    setConfirmPermanent(true);
  }

  function handleEmptyTrash() {
    if (trashTotalCount === 0 || searchInput.trim()) {
      return;
    }
    setConfirmEmpty(true);
  }

  // --- Marquee selection ---
  function handleMarqueeStart(e: React.MouseEvent) {
    if (e.button !== 0) {
      return;
    }
    const target = e.target as HTMLElement;
    if (target.closest("[data-photo-id]")) {
      return;
    }
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    const rect = el.getBoundingClientRect();
    const nextMarquee = {
      startX: e.clientX - rect.left + el.scrollLeft,
      startY: e.clientY - rect.top + el.scrollTop,
      x: e.clientX - rect.left + el.scrollLeft,
      y: e.clientY - rect.top + el.scrollTop,
    };
    marqueeRef.current = nextMarquee;
    setMarquee(nextMarquee);
  }

  const marqueeActive = marquee !== null;
  useEffect(() => {
    if (!marqueeActive) {
      return;
    }
    const el = scrollRef.current;
    if (!el) {
      return;
    }

    function handleMouseMove(e: MouseEvent) {
      if (!el) {
        return;
      }
      const clientX = e.clientX;
      const clientY = e.clientY;
      if (marqueeFrameRef.current !== null) {
        cancelAnimationFrame(marqueeFrameRef.current);
      }
      marqueeFrameRef.current = requestAnimationFrame(() => {
        const previous = marqueeRef.current;
        if (!(previous && el)) {
          return;
        }
        const rect = el.getBoundingClientRect();
        const nextMarquee = {
          ...previous,
          x: clientX - rect.left + el.scrollLeft,
          y: clientY - rect.top + el.scrollTop,
        };
        marqueeRef.current = nextMarquee;
        setMarquee(nextMarquee);
        marqueeFrameRef.current = null;
      });
    }

    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: rectangle intersection and selection update are one atomic pointer gesture
    function handleMouseUp() {
      const scrollEl = el;
      const previous = marqueeRef.current;
      marqueeRef.current = null;
      setMarquee(null);
      if (!(previous && scrollEl)) {
        return;
      }
      const minX = Math.min(previous.startX, previous.x);
      const maxX = Math.max(previous.startX, previous.x);
      const minY = Math.min(previous.startY, previous.y);
      const maxY = Math.max(previous.startY, previous.y);

      if (maxX - minX > 5 || maxY - minY > 5) {
        const cards = scrollEl.querySelectorAll("[data-photo-id]");
        const selected = new Set<number>();
        const containerRect = scrollEl.getBoundingClientRect();
        for (const card of cards) {
          const r = card.getBoundingClientRect();
          const cardLeft = r.left - containerRect.left + scrollEl.scrollLeft;
          const cardTop = r.top - containerRect.top + scrollEl.scrollTop;
          if (
            cardLeft < maxX &&
            cardLeft + r.width > minX &&
            cardTop < maxY &&
            cardTop + r.height > minY
          ) {
            const id = Number((card as HTMLElement).dataset.photoId);
            if (id) {
              selected.add(id);
            }
          }
        }
        if (selected.size > 0) {
          handleMarqueeSelect(selected);
          marqueeJustCompleted.current = true;
        }
      }
    }

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      if (marqueeFrameRef.current !== null) {
        cancelAnimationFrame(marqueeFrameRef.current);
        marqueeFrameRef.current = null;
      }
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [marqueeActive, handleMarqueeSelect]);

  // --- Context menu ---
  function handleContextMenu(e: React.MouseEvent) {
    const card = (e.target as HTMLElement).closest(
      "[data-photo-id]"
    ) as HTMLElement | null;
    if (!card) {
      return;
    }
    const id = Number(card.dataset.photoId || "0");
    if (!id) {
      return;
    }
    e.preventDefault();
    const inSelection = selectedIds.has(id);
    const isBatch = selectedIds.size > 1 && inSelection;
    setCtxMenu({
      open: true,
      x: e.clientX,
      y: e.clientY,
      photoId: id,
      isBatch,
      selectionCount: isBatch ? selectedIds.size : 1,
    });
  }

  const closeCtxMenu = useCallback(() => {
    setCtxMenu((prev) => ({ ...prev, open: false }));
  }, []);

  useEffect(() => {
    if (!ctxMenu.open) {
      return;
    }
    function dismiss(e: MouseEvent) {
      const menuEl = document.getElementById("trash-context-menu");
      if (menuEl && !menuEl.contains(e.target as Node)) {
        closeCtxMenu();
      }
    }
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: keyboard menu navigation maps a small fixed key set
    function keyHandler(e: KeyboardEvent) {
      if (e.key === "Escape") {
        closeCtxMenu();
        return;
      }
      const items = Array.from(
        document.querySelectorAll<HTMLElement>(
          "#trash-context-menu [role='menuitem']:not([disabled])"
        )
      );
      if (items.length === 0) {
        return;
      }
      const currentIndex = items.indexOf(document.activeElement as HTMLElement);
      let nextIndex: number | null = null;
      if (e.key === "ArrowDown") {
        nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % items.length;
      } else if (e.key === "ArrowUp") {
        nextIndex =
          currentIndex < 0
            ? items.length - 1
            : (currentIndex - 1 + items.length) % items.length;
      } else if (e.key === "Home") {
        nextIndex = 0;
      } else if (e.key === "End") {
        nextIndex = items.length - 1;
      }
      if (nextIndex !== null) {
        e.preventDefault();
        items[nextIndex]?.focus();
      }
    }
    function dismissOnViewportChange() {
      closeCtxMenu();
    }
    setTimeout(() => {
      document.addEventListener("mousedown", dismiss, true);
      document.addEventListener("contextmenu", dismiss, true);
      document
        .querySelector<HTMLElement>("#trash-context-menu [role='menuitem']")
        ?.focus();
    }, 0);
    document.addEventListener("keydown", keyHandler);
    window.addEventListener("resize", dismissOnViewportChange);
    scrollRef.current?.addEventListener("scroll", dismissOnViewportChange);
    return () => {
      document.removeEventListener("mousedown", dismiss, true);
      document.removeEventListener("contextmenu", dismiss, true);
      document.removeEventListener("keydown", keyHandler);
      window.removeEventListener("resize", dismissOnViewportChange);
      scrollRef.current?.removeEventListener("scroll", dismissOnViewportChange);
    };
  }, [ctxMenu.open, closeCtxMenu]);

  async function handleCtxRestore() {
    closeCtxMenu();
    if (ctxMenu.isBatch) {
      // 右键目标已在选中集合中，直接使用 selectedIds
      await handleRestore();
      return;
    }
    // 单张模式：只恢复右键那张
    if (ctxMenu.photoId === null) {
      return;
    }
    setRestoring(true);
    try {
      const result = (await ipc.client.photos.restorePhotos({
        ids: [ctxMenu.photoId],
      })) as TrashOperationResult;
      if (result.succeededIds.length > 0) {
        toast.success(
          t("restoredPhotosCount", { count: result.succeededIds.length })
        );
      }
      if ((result.restoredWithoutFolderIds?.length ?? 0) > 0) {
        toast.warning(
          t("restoredWithoutFolderWarning", {
            count: result.restoredWithoutFolderIds?.length ?? 0,
          })
        );
      }
      if (result.failed.length > 0) {
        toast.warning(
          t("trashOperationPartial", { count: result.failed.length })
        );
        handleMarqueeSelect(
          new Set(result.failed.map((failure) => failure.id))
        );
      }
      queryClient.invalidateQueries({
        queryKey: ["photos"],
        refetchType: "active",
      });
      queryClient.invalidateQueries({ queryKey: ["folders"] });
      await loadPhotos(null, false);
    } catch {
      toast.error(t("restoreFailed"));
    } finally {
      setRestoring(false);
    }
  }

  function handleCtxDelete() {
    closeCtxMenu();
    if (ctxMenu.isBatch) {
      // 批量模式：使用 selectedIds
      handlePermanentDelete();
      return;
    }
    // 单张模式：先选中再删除
    if (ctxMenu.photoId === null) {
      return;
    }
    handleKeyboardSelect(ctxMenu.photoId);
    setConfirmPermanent(true);
  }

  function formatTimeAgo(ts: number | null): string {
    if (!ts) {
      return "";
    }
    const diff = Date.now() - ts;
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    if (days === 0) {
      return t("today");
    }
    if (days === 1) {
      return t("yesterday");
    }
    if (days < 7) {
      return t("daysAgo", { count: days });
    }
    if (days < 30) {
      return t("weeksAgo", { count: Math.floor(days / 7) });
    }
    return t("monthsAgo", { count: Math.floor(days / 30) });
  }

  function daysRemaining(ts: number | null): number {
    if (!ts) {
      return 0;
    }
    return Math.max(
      0,
      30 - Math.floor((Date.now() - ts) / (1000 * 60 * 60 * 24))
    );
  }

  async function handlePreviewRestore() {
    if (!previewPhoto) {
      return;
    }
    const photoId = previewPhoto.id;
    setPreviewPhoto(null);
    setRestoring(true);
    try {
      const result = (await ipc.client.photos.restorePhotos({
        ids: [photoId],
      })) as TrashOperationResult;
      if (result.succeededIds.length > 0) {
        toast.success(t("restoredPhotosCount", { count: 1 }));
      }
      if (result.failed.length > 0) {
        toast.warning(
          t("trashOperationPartial", { count: result.failed.length })
        );
        handleMarqueeSelect(new Set([photoId]));
      }
      queryClient.invalidateQueries({
        queryKey: ["photos"],
        refetchType: "active",
      });
      queryClient.invalidateQueries({ queryKey: ["folders"] });
      await loadPhotos(null, false);
    } catch {
      toast.error(t("restoreFailed"));
    } finally {
      setRestoring(false);
    }
  }

  function formatBytes(bytes: number | null): string {
    if (bytes === null) {
      return "";
    }
    if (bytes < 1024) {
      return `${bytes} B`;
    }
    const units = ["KB", "MB", "GB", "TB"];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit++;
    }
    return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
  }

  function expiryDate(ts: number | null): string {
    if (!ts) {
      return "";
    }
    return TRASH_EXPIRY_FORMATTER.format(
      new Date(ts + 30 * 24 * 60 * 60 * 1000)
    );
  }

  const groupedPhotos = useMemo(() => {
    const now = Date.now();
    const groups = new Map<string, DeletedPhoto[]>([
      [t("trashGroupToday"), []],
      [t("trashGroupWeek"), []],
      [t("trashGroupOlder"), []],
    ]);
    for (const photo of photos) {
      const age = photo.deletedAt
        ? now - photo.deletedAt
        : Number.POSITIVE_INFINITY;
      let key = t("trashGroupOlder");
      if (age < 24 * 60 * 60 * 1000) {
        key = t("trashGroupToday");
      } else if (age < 7 * 24 * 60 * 60 * 1000) {
        key = t("trashGroupWeek");
      }
      groups.get(key)?.push(photo);
    }
    return [...groups.entries()].filter(([, items]) => items.length > 0);
  }, [photos, t]);

  const operationRunning = restoring || deleting;

  function renderPhotoCard(photo: DeletedPhoto) {
    const remaining = daysRemaining(photo.deletedAt);
    const secondaryMeta =
      sort === "size"
        ? formatBytes(photo.fileSize)
        : formatTimeAgo(photo.deletedAt);
    return (
      <button
        aria-label={photo.filename}
        aria-pressed={selectedIds.has(photo.id)}
        className={`group relative cursor-pointer overflow-hidden rounded-[10px] border bg-card text-left transition-[border-color,box-shadow,transform] duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
          selectedIds.has(photo.id)
            ? "border-primary bg-primary/[0.02] shadow-sm"
            : "border-border hover:-translate-y-0.5 hover:border-foreground/25 hover:shadow-md"
        }`}
        data-photo-id={photo.id}
        data-photo-path={photo.path}
        key={photo.id}
        onClick={(event) => toggleSelect(photo.id, event)}
        onContextMenu={handleContextMenu}
        onDoubleClick={() => setPreviewPhoto(photo)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            handleKeyboardSelect(photo.id);
          }
        }}
        style={{
          containIntrinsicSize: "240px",
          contentVisibility: "auto",
        }}
        tabIndex={0}
        type="button"
      >
        <div className="relative aspect-square bg-card">
          <div className="absolute inset-0 flex items-center justify-center text-muted-foreground/30">
            <Trash2 className="h-8 w-8" />
          </div>
          {photo.thumbnailPath && (
            // biome-ignore lint/a11y/noNoninteractiveElementInteractions: image error handling only swaps to a non-interactive fallback
            <img
              alt={photo.filename}
              className="relative z-[1] h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.015] motion-reduce:transform-none"
              decoding="async"
              height={photo.height ?? 160}
              loading="lazy"
              onError={(event) => {
                event.currentTarget.hidden = true;
              }}
              src={toLocalMediaUrl(photo.thumbnailPath)}
              width={photo.width ?? 160}
            />
          )}
          {remaining <= 3 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="absolute top-2 right-2 z-[2] rounded-full bg-destructive/90 px-2 py-0.5 font-medium text-[10px] text-white shadow-sm backdrop-blur-sm">
                  {remaining === 0
                    ? t("trashMoveToday")
                    : t("trashMoveAfterDays", { count: remaining })}
                </span>
              </TooltipTrigger>
              <TooltipContent>
                {t("trashExpiresAt", { date: expiryDate(photo.deletedAt) })}
              </TooltipContent>
            </Tooltip>
          )}
        </div>
        <div className="min-h-[54px] px-2.5 py-2">
          <p className="truncate font-medium text-[12px] text-foreground leading-5">
            {photo.filename}
          </p>
          <div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground/75 leading-4">
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="min-w-0 truncate">
                  {photo.folderName ?? t("originalFolderRemoved")}
                </span>
              </TooltipTrigger>
              <TooltipContent>
                {photo.folderName ?? t("originalFolderRemoved")}
              </TooltipContent>
            </Tooltip>
            <span className="shrink-0">{secondaryMeta}</span>
          </div>
        </div>
        <div
          aria-hidden="true"
          className={`absolute top-2 left-2 flex h-5 w-5 items-center justify-center rounded-full border-2 transition-all ${
            selectedIds.has(photo.id)
              ? "border-primary bg-primary text-white"
              : "border-white/80 bg-black/20 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"
          }`}
        >
          {selectedIds.has(photo.id) && (
            <svg
              aria-hidden="true"
              className="h-3 w-3"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                d="M5 13l4 4L19 7"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={3}
              />
            </svg>
          )}
        </div>
      </button>
    );
  }

  function renderTrashContent() {
    if (loading) {
      return (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,160px),1fr))] gap-3">
          {TRASH_SKELETON_KEYS.map((key) => (
            <div
              className="overflow-hidden rounded-[10px] border border-border"
              key={key}
            >
              <Skeleton className="aspect-square rounded-none" />
              <div className="space-y-2 p-2">
                <Skeleton className="h-3 w-4/5" />
                <Skeleton className="h-2.5 w-3/5" />
              </div>
            </div>
          ))}
        </div>
      );
    }
    if (loadError) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3">
          <p className="text-[14px] text-foreground">{t("trashLoadFailed")}</p>
          <button
            className="rounded-[6px] bg-primary px-3 py-1.5 text-[12px] text-primary-foreground"
            onClick={() => loadPhotos(null, false)}
            type="button"
          >
            {t("retry")}
          </button>
        </div>
      );
    }
    if (photos.length === 0) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3">
          <Trash2 className="h-12 w-12 text-muted-foreground/30" />
          <p className="text-[14px] text-muted-foreground">
            {query ? t("trashNoSearchResults") : t("trashEmpty")}
          </p>
          <p className="text-[12px] text-muted-foreground/60">
            {t("trashRetentionHint")}
          </p>
          {query ? (
            <button
              className="rounded-[6px] border border-border px-3 py-1.5 text-[12px] text-foreground hover:bg-foreground/5"
              onClick={() => {
                setSearchInput("");
                searchInputRef.current?.focus();
              }}
              type="button"
            >
              {t("clearSearch")}
            </button>
          ) : (
            <button
              className="rounded-[6px] border border-border px-3 py-1.5 text-[12px] text-foreground hover:bg-foreground/5"
              onClick={() => navigate({ to: "/" })}
              type="button"
            >
              {t("backToHome")}
            </button>
          )}
        </div>
      );
    }

    const displayGroups =
      sort === "deletedAt" ? groupedPhotos : [["", photos] as const];
    return (
      <div className="space-y-6">
        {displayGroups.map(([label, items]) => (
          <section key={label || "all"}>
            {label && (
              <h2 className="mb-2 font-medium text-[12px] text-muted-foreground">
                {label}
              </h2>
            )}
            <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,160px),1fr))] gap-3">
              {items.map(renderPhotoCard)}
            </div>
          </section>
        ))}
        {nextCursor !== null && !loadMoreError && (
          <div className="flex justify-center pb-2">
            <button
              className="flex items-center gap-2 rounded-[6px] border border-border px-4 py-2 text-[12px] text-foreground hover:bg-foreground/5 disabled:opacity-50"
              disabled={loadingMore}
              onClick={() => loadPhotos(nextCursor, true)}
              type="button"
            >
              {loadingMore && <LoadingSpinner size="sm" />}
              {t("loadMore")}
            </button>
          </div>
        )}
        {loadMoreError && nextCursor !== null && (
          <div className="flex items-center justify-center gap-2 pb-2 text-[12px] text-destructive">
            <span>{t("trashLoadMoreFailed")}</span>
            <button
              className="rounded-[6px] border border-border px-2 py-1 text-foreground hover:bg-foreground/5"
              onClick={() => loadPhotos(nextCursor, true)}
              type="button"
            >
              {t("retry")}
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full min-w-0 flex-col bg-background">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-border border-b px-4 py-3 sm:px-6 sm:py-4">
        <div className="flex min-w-0 items-center gap-3">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                aria-label={t("backToHome")}
                className="flex h-8 w-8 items-center justify-center rounded-[6px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
                onClick={() => navigate({ to: "/" })}
                type="button"
              >
                <ArrowLeft className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent>{t("backToHome")}</TooltipContent>
          </Tooltip>
          <div className="min-w-0">
            <h1 className="font-semibold text-[16px] text-foreground">
              {t("recentlyDeletedTitle")}
            </h1>
            <p className="break-words text-[12px] text-muted-foreground">
              {trashTotalCount > 0
                ? t("trashSummary", {
                    bytes: formatBytes(trashTotalBytes),
                    count: trashTotalCount,
                  })
                : t("noDeletedPhotos")}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {selectedIds.size > 0 && (
            <>
              <button
                className="flex items-center gap-1.5 rounded-[6px] bg-primary/10 px-3 py-1.5 text-[13px] text-primary transition-colors hover:bg-primary/20 disabled:opacity-50"
                disabled={operationRunning}
                onClick={handleRestore}
                type="button"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                {t("restoreCount", { count: selectedIds.size })}
              </button>
              <button
                className="flex items-center gap-1.5 rounded-[6px] bg-destructive/10 px-3 py-1.5 text-[13px] text-destructive transition-colors hover:bg-destructive/20 disabled:opacity-50"
                disabled={operationRunning}
                onClick={handlePermanentDelete}
                type="button"
              >
                <Trash2 className="h-3.5 w-3.5" />
                {t("moveToSystemTrash")}
              </button>
            </>
          )}
          {trashTotalCount > 0 && !searchInput.trim() && (
            <button
              className="hidden rounded-[6px] px-3 py-1.5 text-[13px] text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50 sm:block"
              disabled={operationRunning}
              onClick={handleEmptyTrash}
              type="button"
            >
              {t("moveAllToSystemTrash")}
            </button>
          )}
          {trashTotalCount > 0 && !searchInput.trim() && (
            <details className="group relative sm:hidden">
              <summary className="cursor-pointer list-none rounded-[6px] px-3 py-1.5 text-[13px] text-muted-foreground hover:bg-foreground/5">
                {t("moreActions")}
              </summary>
              <div className="absolute top-full right-0 z-40 mt-1 min-w-48 rounded-[8px] border border-border bg-popover p-1 shadow-lg">
                <button
                  className="w-full rounded-[6px] px-3 py-1.5 text-left text-[13px] text-destructive hover:bg-destructive/10 disabled:opacity-50"
                  disabled={operationRunning}
                  onClick={handleEmptyTrash}
                  type="button"
                >
                  {t("moveAllToSystemTrash")}
                </button>
              </div>
            </details>
          )}
        </div>
      </div>

      <div className="relative flex min-h-0 min-w-0 flex-1">
        {/* Selection bar */}
        {!loading && (trashTotalCount > 0 || query) && (
          <div
            className={`page-toolbar absolute top-0 right-0 left-0 z-50 flex flex-wrap items-center justify-between gap-2 overflow-x-hidden border-b px-4 py-2 sm:px-6 ${
              isToolbarScrolled ? "is-scrolled" : ""
            }`}
            ref={toolbarRef}
          >
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
              {photos.length > 0 && (
                <button
                  className="text-[12px] text-muted-foreground hover:text-foreground"
                  disabled={operationRunning}
                  onClick={selectAll}
                  type="button"
                >
                  {selectedIds.size === photos.length
                    ? t("deselectAll")
                    : t("selectLoaded")}
                </button>
              )}
              {selectedIds.size > 0 && (
                <span className="text-[12px] text-muted-foreground">
                  {t("selectedCount", { count: selectedIds.size })}
                </span>
              )}
              <span className="min-w-0 break-words text-[12px] text-muted-foreground/70">
                {query
                  ? t("trashSearchResults", {
                      bytes: formatBytes(totalBytes),
                      count: totalCount,
                    })
                  : t("trashRetentionHint")}
              </span>
            </div>
            <div className="flex w-full min-w-0 flex-wrap items-center gap-2 sm:w-auto sm:flex-nowrap">
              <label className="relative min-w-[min(100%,9rem)] flex-1 sm:flex-none">
                <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <input
                  aria-keyshortcuts="Control+F Meta+F Escape"
                  aria-label={t("trashSearchPlaceholder")}
                  className="h-8 w-full rounded-[6px] border border-border bg-background pr-8 pl-8 text-[12px] outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/20 sm:w-48"
                  onChange={(event) => setSearchInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape" && searchInput) {
                      event.preventDefault();
                      setSearchInput("");
                    }
                  }}
                  placeholder={t("trashSearchPlaceholder")}
                  ref={searchInputRef}
                  type="search"
                  value={searchInput}
                />
                {searchInput && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        aria-label={t("clearSearch")}
                        className="absolute top-1/2 right-1.5 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
                        onClick={() => {
                          setSearchInput("");
                          searchInputRef.current?.focus();
                        }}
                        type="button"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>{t("clearSearch")}</TooltipContent>
                  </Tooltip>
                )}
              </label>
              <FilterDropdown
                ariaLabel={t("sortBy")}
                className="w-full min-w-0"
                onChange={(value) =>
                  setSort(value as "deletedAt" | "name" | "size")
                }
                options={[
                  { label: t("trashSortDeletedAt"), value: "deletedAt" },
                  { label: t("trashSortName"), value: "name" },
                  { label: t("trashSortSize"), value: "size" },
                ]}
                placeholder={t("sortBy")}
                value={sort}
                wrapperClassName="min-w-[min(100%,132px)] flex-1 sm:flex-none"
              />
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    aria-label={
                      order === "desc"
                        ? t("sortDescending")
                        : t("sortAscending")
                    }
                    className="h-8 rounded-[6px] border border-border px-2 text-[12px] text-muted-foreground hover:text-foreground"
                    onClick={() =>
                      setOrder((value) => (value === "desc" ? "asc" : "desc"))
                    }
                    type="button"
                  >
                    {order === "desc" ? "↓" : "↑"}
                  </button>
                </TooltipTrigger>
                <TooltipContent>
                  {order === "desc" ? t("sortDescending") : t("sortAscending")}
                </TooltipContent>
              </Tooltip>
              {refreshing && (
                <span
                  aria-label={t("trashSearching")}
                  aria-live="polite"
                  className="flex items-center"
                  role="status"
                >
                  <LoadingSpinner size="sm" />
                </span>
              )}
            </div>
          </div>
        )}

        {refreshError && (
          <div
            aria-live="polite"
            className="flex items-center justify-center gap-2 border-border border-b bg-destructive/5 px-6 py-1.5 text-[12px] text-destructive"
          >
            <span>{t("trashRefreshFailed")}</span>
            <button
              className="rounded-[6px] border border-border px-2 py-0.5 text-foreground hover:bg-foreground/5"
              onClick={() => loadPhotos(null, false)}
              type="button"
            >
              {t("retry")}
            </button>
          </div>
        )}
        {/* Photo grid */}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: desktop marquee selection intentionally uses the scroll surface */}
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: keyboard users select individual semantic card buttons */}
        {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: desktop marquee selection intentionally uses the scroll surface */}
        <div
          aria-busy={loading || refreshing}
          className="relative min-w-0 flex-1 overflow-y-auto p-4 sm:p-6"
          onClick={(e) => {
            if (marqueeJustCompleted.current) {
              marqueeJustCompleted.current = false;
              return;
            }
            const target = e.target as HTMLElement;
            if (!target.closest("[data-photo-id]")) {
              clearSelection();
            }
          }}
          onMouseDown={handleMarqueeStart}
          onScroll={(event) => {
            const isScrolled = event.currentTarget.scrollTop > 4;
            setIsToolbarScrolled(isScrolled);
            setShowBackToTop(isScrolled);
          }}
          ref={scrollRef}
          style={{
            paddingTop:
              !loading && (trashTotalCount > 0 || query)
                ? (toolbarHeight || TRASH_TOOLBAR_FALLBACK_HEIGHT) +
                  TRASH_TOOLBAR_CONTENT_GAP
                : 0,
            userSelect: "none",
          }}
        >
          {/* Marquee selection overlay */}
          {marquee && (
            <div
              className="pointer-events-none absolute z-10 rounded-[4px] bg-primary/20 ring-1 ring-primary/40"
              style={{
                left: Math.min(marquee.startX, marquee.x),
                top: Math.min(marquee.startY, marquee.y),
                width: Math.abs(marquee.x - marquee.startX),
                height: Math.abs(marquee.y - marquee.startY),
              }}
            />
          )}
          {renderTrashContent()}
        </div>
        <MasonryBackToTop
          label={t("backToTop")}
          onClick={(event) => {
            event.stopPropagation();
            const element = scrollRef.current;
            if (!element) {
              return;
            }
            element.scrollTo({
              top: 0,
              behavior:
                reduceMotion || element.scrollTop > element.clientHeight * 4
                  ? "auto"
                  : "smooth",
            });
          }}
          selectionActive={selectedIds.size > 0}
          show={showBackToTop}
        />
      </div>

      {/* Context menu */}
      {ctxMenu.open && (
        <div
          className="fixed z-50 max-h-[calc(100dvh-1rem)] min-w-[180px] max-w-[calc(100dvw-1rem)] overflow-y-auto overscroll-contain rounded-[8px] border border-border bg-popover p-1 ring-1 ring-foreground/5"
          id="trash-context-menu"
          role="menu"
          style={{
            left: Math.max(8, Math.min(ctxMenu.x, window.innerWidth - 190)),
            top: Math.max(8, Math.min(ctxMenu.y, window.innerHeight - 100)),
          }}
        >
          <button
            className="flex w-full cursor-pointer items-center gap-2.5 rounded-[4px] px-3 py-1.5 text-[13px] text-foreground hover:bg-foreground/10"
            disabled={
              operationRunning || (ctxMenu.photoId === null && !ctxMenu.isBatch)
            }
            onClick={handleCtxRestore}
            role="menuitem"
            type="button"
          >
            <RotateCcw className="h-3.5 w-3.5 flex-shrink-0" />
            {ctxMenu.isBatch
              ? `${t("restoreCount", { count: ctxMenu.selectionCount })}`
              : t("restoreCount", { count: 1 })}
          </button>
          <div className="my-1 h-px bg-border" />
          <button
            className="flex w-full cursor-pointer items-center gap-2.5 rounded-[4px] px-3 py-1.5 text-[13px] text-destructive hover:bg-foreground/10"
            disabled={
              operationRunning || (ctxMenu.photoId === null && !ctxMenu.isBatch)
            }
            onClick={handleCtxDelete}
            role="menuitem"
            type="button"
          >
            <Trash2 className="h-3.5 w-3.5 flex-shrink-0" />
            {ctxMenu.isBatch
              ? `${t("moveToSystemTrash")} (${ctxMenu.selectionCount})`
              : t("moveToSystemTrash")}
          </button>
        </div>
      )}

      <Dialog
        onOpenChange={(open) => {
          if (!open) {
            setPreviewPhoto(null);
          }
        }}
        open={previewPhoto !== null}
      >
        <DialogContent className="max-w-3xl" size="xl">
          <DialogHeader>
            <DialogTitle>{previewPhoto?.filename}</DialogTitle>
            <DialogDescription>
              {previewPhoto?.folderName ?? t("originalFolderRemoved")}
            </DialogDescription>
          </DialogHeader>
          {previewPhoto && (
            <div className="relative flex max-h-[65vh] min-h-64 items-center justify-center overflow-hidden rounded-[8px] bg-black/80">
              <Trash2 className="absolute h-12 w-12 text-white/20" />
              {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: image error handling only swaps to a non-interactive fallback */}
              <img
                alt={previewPhoto.filename}
                className="relative z-[1] max-h-[65vh] max-w-full object-contain"
                decoding="async"
                height={previewPhoto.height ?? 640}
                onError={(event) => {
                  event.currentTarget.hidden = true;
                }}
                src={toLocalMediaUrl(
                  previewPhoto.thumbnailPath ?? previewPhoto.path
                )}
                width={previewPhoto.width ?? 960}
              />
            </div>
          )}
          <DialogFooter>
            <button
              className="rounded-[6px] bg-primary px-3 py-1.5 text-[13px] text-primary-foreground disabled:opacity-50"
              disabled={operationRunning}
              onClick={handlePreviewRestore}
              type="button"
            >
              {t("restoreCount", { count: 1 })}
            </button>
            <button
              className="rounded-[6px] bg-destructive/10 px-3 py-1.5 text-[13px] text-destructive disabled:opacity-50"
              disabled={operationRunning}
              onClick={() => {
                if (previewPhoto) {
                  handleKeyboardSelect(previewPhoto.id);
                  setPreviewPhoto(null);
                  setConfirmPermanent(true);
                }
              }}
              type="button"
            >
              {t("moveToSystemTrash")}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        confirmText={t("moveToSystemTrash")}
        description={t("confirmPermanentDeleteDescription", {
          count: selectedIds.size,
        })}
        destructive
        disabled={deleting}
        onCancel={() => setConfirmPermanent(false)}
        onConfirm={performPermanentDelete}
        open={confirmPermanent}
        title={t("confirmMoveToSystemTrashTitle")}
      />
      <ConfirmDialog
        confirmText={t("moveAllToSystemTrash")}
        description={t("confirmPermanentDeleteDescription", {
          count: trashTotalCount,
        })}
        destructive
        disabled={deleting}
        onCancel={() => setConfirmEmpty(false)}
        onConfirm={performEmptyTrash}
        open={confirmEmpty}
        title={t("confirmMoveAllToSystemTrashTitle")}
      />
    </div>
  );
}

export const Route = createFileRoute("/trash")({
  component: TrashPage,
  errorComponent: RouteError,
});
