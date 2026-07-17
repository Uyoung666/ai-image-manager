import {
  createContext,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ipc } from "@/ipc/manager";
import { queryClient } from "@/providers/QueryProvider";
import type { ExifFilters, SearchCriteria } from "@/types/search";

const SIDEBAR_COLLAPSED_KEY = "sidebar_collapsed";

function loadSidebarState(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true";
  } catch {
    return false;
  }
}

interface SidebarFilterState {
  activeFolderId: number | null;
  activeTagIds: number[];
  appliedSearch: SearchCriteria | null;
  collapsed: boolean;
  favoriteOnly: boolean;
  searchDraft: { filters: ExifFilters; query: string };
  searchResetVersion: number;
  tagMode: "and" | "or";
  totalPhotos: number;
}

export interface BrowseCriteriaState {
  activeFolderId: number | null;
  activeTagIds: number[];
  appliedSearch: SearchCriteria | null;
  favoriteOnly: boolean;
  searchDraft: { filters: ExifFilters; query: string };
  searchResetVersion: number;
  tagMode: "and" | "or";
}

export type BrowseCriteriaAction =
  | { type: "applySearch"; criteria: SearchCriteria }
  | { type: "clearSearch" }
  | { type: "selectAllPhotos" }
  | { type: "selectFavorites"; value: boolean }
  | { type: "selectFolder"; id: number | null }
  | { type: "setDraftFilters"; update: SetStateAction<ExifFilters> }
  | { type: "setDraftQuery"; query: string }
  | { type: "toggleTag"; tagId: number | null }
  | { type: "toggleTagMode" };

export const initialBrowseCriteriaState: BrowseCriteriaState = {
  activeFolderId: null,
  activeTagIds: [],
  appliedSearch: null,
  favoriteOnly: false,
  searchDraft: { filters: {}, query: "" },
  searchResetVersion: 0,
  tagMode: "or",
};

function withoutSearch(
  state: BrowseCriteriaState
): Pick<
  BrowseCriteriaState,
  "appliedSearch" | "searchDraft" | "searchResetVersion"
> {
  return {
    appliedSearch: null,
    searchDraft: { filters: {}, query: "" },
    searchResetVersion: state.searchResetVersion + 1,
  };
}

export function browseCriteriaReducer(
  state: BrowseCriteriaState,
  action: BrowseCriteriaAction
): BrowseCriteriaState {
  switch (action.type) {
    case "applySearch":
      return {
        ...state,
        activeFolderId: null,
        activeTagIds: [],
        appliedSearch: action.criteria,
        favoriteOnly: false,
        searchDraft: {
          filters: action.criteria.filters,
          query: action.criteria.query,
        },
      };
    case "clearSearch":
      return { ...state, ...withoutSearch(state) };
    case "selectAllPhotos":
      return {
        ...state,
        activeFolderId: null,
        activeTagIds: [],
        favoriteOnly: false,
        ...withoutSearch(state),
      };
    case "selectFavorites":
      return {
        ...state,
        activeFolderId: null,
        activeTagIds: [],
        favoriteOnly: action.value,
        ...withoutSearch(state),
      };
    case "selectFolder":
      return {
        ...state,
        activeFolderId: action.id,
        activeTagIds: [],
        favoriteOnly: false,
        ...withoutSearch(state),
      };
    case "setDraftFilters":
      return {
        ...state,
        searchDraft: {
          ...state.searchDraft,
          filters:
            typeof action.update === "function"
              ? action.update(state.searchDraft.filters)
              : action.update,
        },
      };
    case "setDraftQuery":
      return {
        ...state,
        searchDraft: { ...state.searchDraft, query: action.query },
      };
    case "toggleTag": {
      let activeTagIds: number[] = [];
      if (action.tagId !== null) {
        activeTagIds = state.activeTagIds.includes(action.tagId)
          ? state.activeTagIds.filter((id) => id !== action.tagId)
          : [...state.activeTagIds, action.tagId];
      }
      return {
        ...state,
        activeTagIds,
        favoriteOnly: false,
        ...withoutSearch(state),
      };
    }
    case "toggleTagMode":
      return { ...state, tagMode: state.tagMode === "or" ? "and" : "or" };
    default:
      return state;
  }
}

interface SidebarFilterActions {
  applySearch: (criteria: SearchCriteria) => void;
  clearSearch: () => void;
  handleAddFolder: (externalPath?: string) => void;
  handleDeleteFolder: (id: number) => void;
  selectAllPhotos: () => void;
  selectFolder: (id: number | null) => void;
  setActiveFolderId: (id: number | null) => void;
  setFavoriteOnly: (v: boolean) => void;
  setSearchDraftFilters: Dispatch<SetStateAction<ExifFilters>>;
  setSearchDraftQuery: (query: string) => void;
  setTotalPhotos: (n: number) => void;
  toggleCollapsed: () => void;
  toggleFavorites: () => void;
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
  const [criteria, dispatchCriteria] = useReducer(
    browseCriteriaReducer,
    initialBrowseCriteriaState
  );
  const {
    activeFolderId,
    activeTagIds,
    appliedSearch,
    favoriteOnly,
    searchDraft,
    searchResetVersion,
    tagMode,
  } = criteria;

  // --- Sidebar UI state ---
  const [collapsed, setCollapsed] = useState(loadSidebarState);

  // --- Shared data ---
  const [totalPhotos, setTotalPhotos] = useState(0);

  // --- Filter actions ---

  const setActiveFolderId = useCallback((id: number | null) => {
    dispatchCriteria({ type: "selectFolder", id });
  }, []);

  const setFavoriteOnly = useCallback((v: boolean) => {
    dispatchCriteria({ type: "selectFavorites", value: v });
  }, []);

  const selectFolder = useCallback((id: number | null) => {
    dispatchCriteria({ type: "selectFolder", id });
  }, []);

  const selectAllPhotos = useCallback(() => {
    dispatchCriteria({ type: "selectAllPhotos" });
  }, []);

  const toggleFavorites = useCallback(() => {
    dispatchCriteria({ type: "selectFavorites", value: !favoriteOnly });
  }, [favoriteOnly]);

  const toggleTag = useCallback((tagId: number | null) => {
    dispatchCriteria({ type: "toggleTag", tagId });
    // 清除搜索状态，确保标签筛选结果不会被舊的搜索模式覆盖
  }, []);

  const toggleTagMode = useCallback(() => {
    dispatchCriteria({ type: "toggleTagMode" });
  }, []);

  const applySearch = useCallback((search: SearchCriteria) => {
    dispatchCriteria({ type: "applySearch", criteria: search });
  }, []);

  const clearSearch = useCallback(() => {
    dispatchCriteria({ type: "clearSearch" });
  }, []);

  const setSearchDraftQuery = useCallback((query: string) => {
    dispatchCriteria({ type: "setDraftQuery", query });
  }, []);

  const setSearchDraftFilters: Dispatch<SetStateAction<ExifFilters>> =
    useCallback((update) => {
      dispatchCriteria({ type: "setDraftFilters", update });
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
        if (activeFolderId === id) {
          dispatchCriteria({ type: "selectAllPhotos" });
        }
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
    [activeFolderId, t]
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
      appliedSearch,
      searchDraft,
      searchResetVersion,
      // Actions
      applySearch,
      clearSearch,
      setSearchDraftFilters,
      setSearchDraftQuery,
      setActiveFolderId,
      setFavoriteOnly,
      selectAllPhotos,
      selectFolder,
      toggleFavorites,
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
      appliedSearch,
      searchDraft,
      searchResetVersion,
      applySearch,
      clearSearch,
      setSearchDraftFilters,
      setSearchDraftQuery,
      setActiveFolderId,
      setFavoriteOnly,
      selectAllPhotos,
      selectFolder,
      toggleFavorites,
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
