import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ipc } from "@/ipc/manager";
import { queryClient } from "@/providers/QueryProvider";

const SIDEBAR_COLLAPSED_KEY = "sidebar_collapsed";

function loadSidebarState(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true";
  } catch {
    return false;
  }
}

interface SidebarFilterState {
  // Filter state (drives usePhotos query)
  activeFolderId: number | null;
  activeTagIds: number[];

  // Sidebar UI state
  collapsed: boolean;
  favoriteOnly: boolean;

  tagMode: "and" | "or";

  // Shared data
  totalPhotos: number;
}

interface SidebarFilterActions {
  // Import actions
  handleAddFolder: (externalPath?: string) => void;
  handleDeleteFolder: (id: number) => void;
  selectFolderAndNotify: (id: number | null) => void;
  // Filter actions
  setActiveFolderId: (id: number | null) => void;
  setFavoriteOnly: (v: boolean) => void;

  // Shared data setters
  setTotalPhotos: (n: number) => void;

  // Sidebar UI actions
  toggleCollapsed: () => void;
  toggleFavoritesAndNotify: () => void;
  toggleTag: (tagId: number | null) => void;
  toggleTagMode: () => void;
}

type SidebarFilterContextValue = SidebarFilterState & SidebarFilterActions;

const SidebarFilterContext = createContext<SidebarFilterContextValue | null>(
  null
);

export function SidebarFilterProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();

  // --- Filter state ---
  const [activeFolderId, setActiveFolderIdState] = useState<number | null>(
    null
  );
  const [activeTagIds, setActiveTagIds] = useState<number[]>([]);
  const [favoriteOnly, setFavoriteOnlyState] = useState(false);
  const [tagMode, setTagMode] = useState<"and" | "or">("or");

  // --- Sidebar UI state ---
  const [collapsed, setCollapsed] = useState(loadSidebarState);

  // --- Shared data ---
  const [totalPhotos, setTotalPhotos] = useState(0);

  // --- Filter actions ---

  const setActiveFolderId = useCallback((id: number | null) => {
    setActiveFolderIdState(id);
    setFavoriteOnlyState(false);
    setActiveTagIds([]);
  }, []);

  const setFavoriteOnly = useCallback((v: boolean) => {
    setFavoriteOnlyState(v);
    if (v) {
      setActiveFolderIdState(null);
      setActiveTagIds([]);
    }
  }, []);

  // Sidebar-triggered actions that also notify HomePage to clear search state.
  // Regular setActiveFolderId / setFavoriteOnly are kept for internal use
  // (drill-down, etc.) where clearing search is handled separately.
  const selectFolderAndNotify = useCallback((id: number | null) => {
    setActiveFolderIdState(id);
    setFavoriteOnlyState(false);
    setActiveTagIds([]);
    window.dispatchEvent(new CustomEvent("sidebar:clear-search"));
  }, []);

  const toggleFavoritesAndNotify = useCallback(() => {
    setFavoriteOnlyState((prev) => !prev);
    // Always clear folder/tag when toggling favorites — matches the original
    // inline onSelectFavorites behavior which unconditionally reset both.
    setActiveFolderIdState(null);
    setActiveTagIds([]);
    window.dispatchEvent(new CustomEvent("sidebar:clear-search"));
  }, []);

  const toggleTag = useCallback((tagId: number | null) => {
    if (tagId === null) {
      setActiveTagIds([]);
      window.dispatchEvent(new CustomEvent("sidebar:clear-search"));
      return;
    }
    setActiveTagIds((prev) => {
      if (prev.includes(tagId)) {
        return prev.filter((id) => id !== tagId);
      }
      return [...prev, tagId];
    });
    setFavoriteOnlyState(false);
    // 清除搜索状态，确保标签筛选结果不会被舊的搜索模式覆盖
    window.dispatchEvent(new CustomEvent("sidebar:clear-search"));
  }, []);

  const toggleTagMode = useCallback(() => {
    setTagMode((m) => (m === "or" ? "and" : "or"));
  }, []);

  // --- Import actions ---

  const handleAddFolder = useCallback(
    async (externalPath?: string) => {
      let folderPath =
        typeof externalPath === "string" ? externalPath : undefined;
      if (!folderPath) {
        const result = await ipc.client.shell.openFolderDialog({});
        folderPath = result?.path ?? undefined;
      }
      if (!folderPath) {
        return;
      }

      // 入队后台顺序导入 — scanFolder 立即返回，不阻塞 UI
      try {
        const enqueued = await ipc.client.photos.scanFolder({
          path: folderPath,
        });
        if (enqueued.status === "queued") {
          toast.success(t("toastImportQueued"));
        }
      } catch (err: unknown) {
        console.error("[scanFolder] failed:", err);
        const detail = err instanceof Error ? err.message : String(err);
        toast.error(`${t("toastScanFolderFailed")}: ${detail}`);
      }
    },
    [t]
  );

  const handleDeleteFolder = useCallback(
    async (id: number) => {
      try {
        await ipc.client.photos.deleteFolder({ id });
        // If the deleted folder is the currently active one, deselect it
        setActiveFolderIdState((prev) => (prev === id ? null : prev));
        queryClient.invalidateQueries({ queryKey: ["folders"] });
        queryClient.invalidateQueries({
          queryKey: ["photos"],
          refetchType: "active",
        });
        toast.success(t("toastFolderRemoved"));
      } catch {
        toast.error(t("toastDeleteFolderFailed"));
      }
    },
    [t]
  );

  // --- Sidebar UI actions ---

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  // --- Auto-collapse sidebar when window is narrow ---
  const autoCollapsedRef = useRef(false);
  useEffect(() => {
    function handleResize() {
      const narrow = window.innerWidth < 900;
      if (narrow && !collapsed) {
        autoCollapsedRef.current = true;
        setCollapsed(true);
      } else if (!narrow && autoCollapsedRef.current) {
        autoCollapsedRef.current = false;
        setCollapsed(loadSidebarState());
      }
    }
    window.addEventListener("resize", handleResize);
    handleResize();
    return () => window.removeEventListener("resize", handleResize);
  }, [collapsed]);

  // --- Context value ---
  const value = useMemo<SidebarFilterContextValue>(
    () => ({
      // State
      activeFolderId,
      activeTagIds,
      favoriteOnly,
      tagMode,
      collapsed,
      totalPhotos,
      // Actions
      setActiveFolderId,
      setFavoriteOnly,
      selectFolderAndNotify,
      toggleFavoritesAndNotify,
      toggleTag,
      toggleTagMode,
      handleAddFolder,
      handleDeleteFolder,
      toggleCollapsed,
      setTotalPhotos,
    }),
    [
      activeFolderId,
      activeTagIds,
      favoriteOnly,
      tagMode,
      collapsed,
      totalPhotos,
      setActiveFolderId,
      setFavoriteOnly,
      selectFolderAndNotify,
      toggleFavoritesAndNotify,
      toggleTag,
      toggleTagMode,
      handleAddFolder,
      handleDeleteFolder,
      toggleCollapsed,
    ]
  );

  return (
    <SidebarFilterContext.Provider value={value}>
      {children}
    </SidebarFilterContext.Provider>
  );
}

export function useSidebarFilter(): SidebarFilterContextValue {
  const ctx = useContext(SidebarFilterContext);
  if (!ctx) {
    throw new Error(
      "useSidebarFilter must be used within <SidebarFilterProvider>"
    );
  }
  return ctx;
}
