import { useCallback, useEffect, useRef, useState } from "react";
import { useBrowseSession } from "@/contexts/BrowseSessionContext";

interface Photo {
  id: number;
  [key: string]: any;
}

interface UsePhotoSelectionReturn {
  addToSelection: (ids: number[]) => void;
  clearSelection: () => void;
  handleKeyboardSelect: (id: number) => void;
  handleMarqueeSelect: (ids: Set<number>) => void;
  handleSelect: (id: number, event: React.MouseEvent) => void;
  handleSelectMany: (ids: number[], event: React.MouseEvent) => void;
  lastClickedIdx: number;
  removeFromSelection: (ids: number[]) => void;
  selectAll: () => void;
  selectedIds: Set<number>;
}

/**
 * 选中状态管理 Hook
 *
 * 特性：
 * - 支持 Shift 范围选择、Ctrl/Cmd 切换选择、单选
 * - 通过 BrowseSessionContext 跨路由持久化（5分钟过期）
 * - lastClickedIdx 锚点跟踪
 *
 * @param routeKey - 路由唯一标识，用于跨路由持久化
 * @param photos - 当前照片数组（用于 selectAll 和 Shift 范围计算）
 */
export function usePhotoSelection(
  routeKey: string,
  photos: Photo[]
): UsePhotoSelectionReturn {
  const { getSession, saveSession } = useBrowseSession();

  // 初始化：从 BrowseSessionContext 恢复选中状态（仅首次挂载）
  const [selectedIds, setSelectedIds] = useState<Set<number>>(() => {
    const session = getSession(routeKey);
    if (session.selectedIds.length > 0) {
      const validIds = session.selectedIds.filter((id) =>
        photos.some((p) => p.id === id)
      );
      return new Set(validIds);
    }
    return new Set<number>();
  });

  const [lastClickedIdx, setLastClickedIdx] = useState<number>(
    () => getSession(routeKey).lastClickedIdx
  );

  // 当 routeKey 在同一个组件实例内变化时（如首页切换文件夹/排序），
  // 重新从 session 加载对应路由的选中状态，避免跨 filter 的选中污染。
  useEffect(() => {
    const session = getSession(routeKey);
    const validIds = session.selectedIds.filter((id) =>
      photos.some((p) => p.id === id)
    );
    setSelectedIds(new Set(validIds));
    setLastClickedIdx(session.lastClickedIdx);
  }, [routeKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // 持久化：selectedIds 变化时保存
  const selectedIdsRef = useRef(selectedIds);
  selectedIdsRef.current = selectedIds;
  const lastClickedIdxRef = useRef(lastClickedIdx);
  lastClickedIdxRef.current = lastClickedIdx;

  // 组件卸载时保存最终状态
  useEffect(() => {
    return () => {
      saveSession(routeKey, {
        selectedIds: Array.from(selectedIdsRef.current),
        lastClickedIdx: lastClickedIdxRef.current,
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeKey]);

  const handleSelect = useCallback(
    (id: number, event: React.MouseEvent) => {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        const idx = photos.findIndex((p) => p.id === id);

        if (event.shiftKey && lastClickedIdxRef.current >= 0 && idx >= 0) {
          const [from, to] =
            lastClickedIdxRef.current < idx
              ? [lastClickedIdxRef.current, idx]
              : [idx, lastClickedIdxRef.current];
          for (let i = from; i <= to; i++) {
            next.add(photos[i].id);
          }
        } else if (event.ctrlKey || event.metaKey) {
          if (next.has(id)) {
            next.delete(id);
          } else {
            next.add(id);
          }
          if (idx >= 0) {
            setLastClickedIdx(idx);
          }
        } else {
          next.clear();
          next.add(id);
          if (idx >= 0) {
            setLastClickedIdx(idx);
          }
        }

        // 持久化到 BrowseSessionContext
        saveSession(routeKey, {
          selectedIds: Array.from(next),
          lastClickedIdx: idx >= 0 ? idx : lastClickedIdxRef.current,
        });

        return next;
      });
    },
    [photos, routeKey, saveSession]
  );

  const handleKeyboardSelect = useCallback(
    (id: number) => {
      setSelectedIds(new Set([id]));
      const idx = photos.findIndex((p) => p.id === id);
      if (idx >= 0) {
        setLastClickedIdx(idx);
        saveSession(routeKey, {
          selectedIds: [id],
          lastClickedIdx: idx,
        });
      }
    },
    [photos, routeKey, saveSession]
  );

  const handleSelectMany = useCallback(
    (ids: number[], event: React.MouseEvent) => {
      const uniqueIds = [...new Set(ids)];
      if (uniqueIds.length === 0) {
        return;
      }
      setSelectedIds((prev) => {
        const next = new Set(prev);
        const allSelected = uniqueIds.every((id) => next.has(id));
        if (event.ctrlKey || event.metaKey) {
          for (const id of uniqueIds) {
            if (allSelected) {
              next.delete(id);
            } else {
              next.add(id);
            }
          }
        } else {
          next.clear();
          for (const id of uniqueIds) {
            next.add(id);
          }
        }
        const anchorId = uniqueIds[0];
        const idx = photos.findIndex((photo) => photo.id === anchorId);
        if (idx >= 0) {
          setLastClickedIdx(idx);
        }
        saveSession(routeKey, {
          selectedIds: Array.from(next),
          lastClickedIdx: idx >= 0 ? idx : lastClickedIdxRef.current,
        });
        return next;
      });
    },
    [photos, routeKey, saveSession]
  );

  const addToSelection = useCallback(
    (ids: number[]) => {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const id of ids) {
          next.add(id);
        }
        saveSession(routeKey, { selectedIds: Array.from(next) });
        return next;
      });
    },
    [routeKey, saveSession]
  );

  const handleMarqueeSelect = useCallback(
    (ids: Set<number>) => {
      setSelectedIds(ids);
      saveSession(routeKey, {
        selectedIds: Array.from(ids),
      });
    },
    [routeKey, saveSession]
  );

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
    setLastClickedIdx(-1);
    saveSession(routeKey, {
      selectedIds: [],
      lastClickedIdx: -1,
    });
  }, [routeKey, saveSession]);

  const removeFromSelection = useCallback(
    (ids: number[]) => {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const id of ids) {
          next.delete(id);
        }
        saveSession(routeKey, {
          selectedIds: Array.from(next),
        });
        return next;
      });
    },
    [routeKey, saveSession]
  );

  const selectAll = useCallback(() => {
    if (selectedIdsRef.current.size === photos.length) {
      clearSelection();
    } else {
      const allIds = new Set(photos.map((p) => p.id));
      setSelectedIds(allIds);
      saveSession(routeKey, {
        selectedIds: Array.from(allIds),
      });
    }
  }, [photos, routeKey, saveSession, clearSelection]);

  return {
    addToSelection,
    selectedIds,
    lastClickedIdx,
    handleSelect,
    handleSelectMany,
    handleKeyboardSelect,
    handleMarqueeSelect,
    clearSelection,
    removeFromSelection,
    selectAll,
  };
}
