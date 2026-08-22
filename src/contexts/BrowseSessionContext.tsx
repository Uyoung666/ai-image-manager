import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useRef,
} from "react";
import type { DashboardReturnTarget } from "@/utils/dashboard-data";

/**
 * 浏览上下文：按 routeKey 独立保存每个页面的浏览状态
 *
 * 与 ScrollPositionContext 互补：
 * - ScrollPositionContext 保存滚动位置（视觉位置）
 * - BrowseSessionContext 保存交互状态（选中、搜索等逻辑状态）
 *
 * 两者结合，路由切换时用户获得完整的浏览上下文恢复。
 */

interface BrowseSessionData {
  /** 颜色搜索的 hex 值 */
  colorHex: string | null;
  /** 仪表盘钻取后可返回的受控目标 */
  dashboardReturn: DashboardReturnTarget | null;
  /** 详情面板是否被用户手动关闭 */
  detailDismissed: boolean;
  /** 当前会话的以图搜图参考图片路径 */
  imageSearchPath: string | null;
  /** 最后一次点击的索引（用于 Shift-多选） */
  lastClickedIdx: number;
  /** 搜索模式 (null = 非搜索) */
  searchMode: string | null;
  /** 搜索关键词 */
  searchQuery: string;
  /** 选中的照片 ID 集合 */
  selectedIds: number[];
  /** 首页瀑布流展示模式 */
  sequenceMode: "photos" | "sequences";
}

const DEFAULT_SESSION: BrowseSessionData = {
  colorHex: null,
  dashboardReturn: null,
  imageSearchPath: null,
  lastClickedIdx: -1,
  detailDismissed: false,
  searchMode: null,
  searchQuery: "",
  sequenceMode: "photos",
  selectedIds: [],
};

interface BrowseSessionContextValue {
  /**
   * 清除指定路由的浏览上下文
   */
  clearSession: (routeKey: string) => void;
  /**
   * 获取指定路由的浏览上下文
   * 内存读取优先，sessionStorage 回退
   */
  getSession: (routeKey: string) => BrowseSessionData;

  /**
   * 保存指定路由的浏览上下文
   * 合并模式：只更新传入的字段，未传入的字段保留原值或默认值
   */
  saveSession: (routeKey: string, partial: Partial<BrowseSessionData>) => void;
}

const BrowseSessionContext = createContext<BrowseSessionContextValue | null>(
  null
);

// 最大缓存路由数量
const MAX_CACHED_ROUTES = 30;
// sessionStorage 键前缀
const STORAGE_KEY_PREFIX = "browse_session_";
// 会话过期时间：30 分钟（与 ScrollPositionContext 保持一致）
const SESSION_EXPIRY_MS = 30 * 60 * 1000;

// 内存 session 包装，带最后访问时间戳
interface CachedSession {
  data: BrowseSessionData;
  lastAccess: number;
}

interface BrowseSessionDebugWindow extends Window {
  __inspectBrowseSessions?: () => Map<string, BrowseSessionData>;
}

function readStoredSession(routeKey: string): CachedSession | null {
  try {
    const stored = sessionStorage.getItem(`${STORAGE_KEY_PREFIX}${routeKey}`);
    if (!stored) {
      return null;
    }
    const parsed = JSON.parse(stored) as BrowseSessionData;
    if (
      !Array.isArray(parsed.selectedIds) ||
      typeof parsed.searchQuery !== "string"
    ) {
      return null;
    }
    return {
      data: {
        ...DEFAULT_SESSION,
        ...parsed,
        imageSearchPath:
          typeof parsed.imageSearchPath === "string"
            ? parsed.imageSearchPath
            : null,
        sequenceMode: normalizeSequenceMode(parsed.sequenceMode),
      },
      lastAccess: Date.now(),
    };
  } catch {
    console.debug("[BrowseSessionContext] sessionStorage read failed");
    return null;
  }
}

function isSessionExpired(cached: CachedSession): boolean {
  return Date.now() - cached.lastAccess > SESSION_EXPIRY_MS;
}

function normalizeSequenceMode(value: unknown): "photos" | "sequences" {
  return value === "sequences" ? "sequences" : "photos";
}

export function BrowseSessionProvider({ children }: { children: ReactNode }) {
  const sessionsRef = useRef<Map<string, CachedSession>>(new Map());

  // LRU 淘汰：当缓存超过上限时，删除最久未访问的条目
  const ensureCacheLimit = useCallback(() => {
    const sessions = sessionsRef.current;
    if (sessions.size >= MAX_CACHED_ROUTES) {
      let oldestKey: string | null = null;
      let oldestTime = Number.POSITIVE_INFINITY;
      for (const [key, cached] of sessions.entries()) {
        if (cached.lastAccess < oldestTime) {
          oldestTime = cached.lastAccess;
          oldestKey = key;
        }
      }
      if (oldestKey) {
        sessions.delete(oldestKey);
      }
    }
  }, []);

  const saveSession = useCallback(
    (routeKey: string, partial: Partial<BrowseSessionData>) => {
      ensureCacheLimit();

      const existing = sessionsRef.current.get(routeKey)?.data ?? {
        ...DEFAULT_SESSION,
      };
      const updated: BrowseSessionData = { ...existing, ...partial };

      // 如果所有字段都是默认值，删除而不是保存
      const isDefault =
        updated.selectedIds.length === 0 &&
        updated.dashboardReturn === null &&
        updated.searchQuery === "" &&
        updated.searchMode === null &&
        updated.imageSearchPath === null &&
        updated.colorHex === null &&
        updated.sequenceMode === "photos" &&
        updated.lastClickedIdx === -1 &&
        updated.detailDismissed === false;

      if (isDefault) {
        sessionsRef.current.delete(routeKey);
        try {
          sessionStorage.removeItem(`${STORAGE_KEY_PREFIX}${routeKey}`);
        } catch {
          /* ignore */
        }
        return;
      }

      sessionsRef.current.set(routeKey, {
        data: updated,
        lastAccess: Date.now(),
      });

      // 同步到 sessionStorage
      try {
        sessionStorage.setItem(
          `${STORAGE_KEY_PREFIX}${routeKey}`,
          JSON.stringify(updated)
        );
      } catch {
        // sessionStorage 不可用时静默忽略
        console.debug("[BrowseSessionContext] sessionStorage write failed");
      }
    },
    [ensureCacheLimit]
  );

  const getSession = useCallback((routeKey: string): BrowseSessionData => {
    let cached = sessionsRef.current.get(routeKey);
    if (!cached) {
      cached = readStoredSession(routeKey) ?? undefined;
      if (cached) {
        sessionsRef.current.set(routeKey, cached);
      }
    }

    if (!cached) {
      return { ...DEFAULT_SESSION };
    }
    if (isSessionExpired(cached)) {
      sessionsRef.current.delete(routeKey);
      try {
        sessionStorage.removeItem(`${STORAGE_KEY_PREFIX}${routeKey}`);
      } catch {
        /* ignore */
      }
      return { ...DEFAULT_SESSION };
    }

    cached.lastAccess = Date.now();
    return cached.data;
  }, []);
  const clearSession = useCallback((routeKey: string) => {
    sessionsRef.current.delete(routeKey);
    try {
      sessionStorage.removeItem(`${STORAGE_KEY_PREFIX}${routeKey}`);
    } catch {
      /* ignore */
    }
  }, []);

  const value: BrowseSessionContextValue = {
    getSession,
    saveSession,
    clearSession,
  };

  return (
    <BrowseSessionContext.Provider value={value}>
      {children}
    </BrowseSessionContext.Provider>
  );
}

export function useBrowseSession(): BrowseSessionContextValue {
  const ctx = useContext(BrowseSessionContext);
  if (!ctx) {
    throw new Error(
      "useBrowseSession must be used within <BrowseSessionProvider>"
    );
  }
  return ctx;
}

// 开发环境调试工具
if (import.meta.env.DEV) {
  const debugWindow = window as BrowseSessionDebugWindow;
  debugWindow.__inspectBrowseSessions = () => {
    const sessions = new Map<string, BrowseSessionData>();
    try {
      for (let i = 0; i < sessionStorage.length; i++) {
        const key = sessionStorage.key(i);
        if (key?.startsWith(STORAGE_KEY_PREFIX)) {
          const routeKey = key.replace(STORAGE_KEY_PREFIX, "");
          const stored = sessionStorage.getItem(key);
          if (stored) {
            const data = JSON.parse(stored) as BrowseSessionData;
            sessions.set(routeKey, data);
          }
        }
      }
    } catch {
      /* ignore */
    }
    console.table(
      Array.from(sessions.entries()).map(([route, session]) => ({
        route,
        selectedCount: session.selectedIds.length,
        searchQuery: session.searchQuery || "(none)",
        lastClickedIdx: session.lastClickedIdx,
        detailDismissed: session.detailDismissed,
      }))
    );
    return sessions;
  };
}
