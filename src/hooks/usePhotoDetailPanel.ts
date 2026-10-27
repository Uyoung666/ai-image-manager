import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useBrowseSession } from "@/contexts/BrowseSessionContext";
import type { Photo } from "@/types/photo";
import { getTagsChangedDetail } from "@/utils/tag-change-event";

interface UsePhotoDetailPanelReturn {
  detailDismissed: boolean;
  detailPhoto: Photo | null;
  dismissDetail: () => void;
  navigateDetail: (direction: "prev" | "next") => void;
  showPhoto: (photo: Photo) => void;
}

interface TagEditSession {
  order: number[];
  photo: Photo;
  routeKey: string;
}

function shouldEndTagEdit(
  editing: TagEditSession | null,
  routeKey: string,
  selectedIds: Set<number>
) {
  return (
    editing &&
    (editing.routeKey !== routeKey ||
      selectedIds.size > 1 ||
      (selectedIds.size === 1 && !selectedIds.has(editing.photo.id)))
  );
}

/**
 * 详情面板状态管理 Hook
 *
 * 特性：
 * - 自动同步 selectedIds → detailPhoto
 * - 支持 detailDismissed 手动关闭状态（不影响选中）
 * - prevSelectedIdRef 检测新选择自动重开面板
 * - 支持 prev/next 导航
 *
 * @param selectedIds - 当前选中的照片 ID 集合
 * @param photos - 当前照片数组
 * @param routeKey - 路由标识，用于持久化 detailDismissed
 * @param onSelect - 选中回调（导航到 prev/next 时调用）
 */
export function usePhotoDetailPanel(
  selectedIds: Set<number>,
  photos: Photo[],
  routeKey: string,
  onSelect: (id: number) => void,
  retainOnTagChange = false,
  editScopeKey = routeKey
): UsePhotoDetailPanelReturn {
  const { getSession, saveSession } = useBrowseSession();

  const [detailPhoto, setDetailPhoto] = useState<Photo | null>(null);
  const [detailDismissed, setDetailDismissed] = useState<boolean>(
    () => getSession(routeKey).detailDismissed
  );
  const prevSelectedIdRef = useRef<number | null>(null);

  // 用 ref 追踪用户主动 dismiss（与 effect 输出的 detailDismissed 解耦）
  const userDismissedRef = useRef(false);

  // 用 ref 追踪当前 detailPhoto id，避免将 detailPhoto 放入 effect 依赖
  const detailPhotoIdRef = useRef<number | null>(null);
  const editingRef = useRef<TagEditSession | null>(null);
  const currentRef = useRef({ detailPhoto, photos, routeKey: editScopeKey });
  currentRef.current = { detailPhoto, photos, routeKey: editScopeKey };

  useEffect(() => {
    if (!retainOnTagChange) {
      return;
    }
    const retain = (event: Event) => {
      const detail = getTagsChangedDetail(event);
      const current = currentRef.current;
      if (
        detail?.source !== "detail" ||
        !current.detailPhoto ||
        !detail.photoIds?.includes(current.detailPhoto.id)
      ) {
        return;
      }
      if (
        editingRef.current?.photo.id !== current.detailPhoto.id ||
        editingRef.current.routeKey !== current.routeKey
      ) {
        editingRef.current = {
          photo: { ...current.detailPhoto },
          order: current.photos.map((photo) => photo.id),
          routeKey: current.routeKey,
        };
        setDetailPhoto(editingRef.current.photo);
      }
    };
    window.addEventListener("tags-changed", retain);
    return () => window.removeEventListener("tags-changed", retain);
  }, [retainOnTagChange]);

  // 同步 selectedIds → detailPhoto
  // 规则：
  // 1. 选了不同照片 → 总是打开面板（重置 dismissed）
  // 2. 选了相同照片 + 未 dismissed → 保持打开
  // 3. 选了相同照片 + 已 dismissed → 重新打开（用户主动再次点击）
  // 4. 多选或无选中 → 关闭面板
  //
  // 注意：detailDismissed 和 detailPhoto 不在依赖数组中。
  // 它们由本 effect 输出（setState），通过 ref 解耦避免循环。
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: selection, dismissal and the temporary tag-edit session must commit before paint.
  useLayoutEffect(() => {
    if (shouldEndTagEdit(editingRef.current, editScopeKey, selectedIds)) {
      editingRef.current = null;
    }
    if (selectedIds.size === 1) {
      const id = selectedIds.values().next().value;
      if (id === undefined) {
        return;
      }
      const isNewSelection = id !== prevSelectedIdRef.current;
      const shouldReopen = isNewSelection || userDismissedRef.current;
      if (shouldReopen) {
        userDismissedRef.current = false;
        setDetailDismissed(false);
        prevSelectedIdRef.current = id;
        saveSession(routeKey, { detailDismissed: false });
        const photo = photos.find((p) => p.id === id);
        setDetailPhoto(photo ?? null);
        detailPhotoIdRef.current = photo?.id ?? null;
      } else {
        const photo = photos.find((p) => p.id === id);
        if (photo && photo.id !== detailPhotoIdRef.current) {
          setDetailPhoto(photo);
          detailPhotoIdRef.current = photo.id;
        }
      }
      return;
    }

    // A tag edit may remove this photo from the result and the visible selection.
    // Keep only the inspector session; batch operations still use visible IDs.
    if (editingRef.current && !userDismissedRef.current) {
      return;
    }

    if (detailPhotoIdRef.current !== null) {
      setDetailPhoto(null);
      detailPhotoIdRef.current = null;
    }
    prevSelectedIdRef.current = null;
    userDismissedRef.current = false;
  }, [selectedIds, photos, routeKey, editScopeKey, saveSession]);
  const dismissDetail = useCallback(() => {
    editingRef.current = null;
    userDismissedRef.current = true;
    setDetailDismissed(true);
    setDetailPhoto(null);
    detailPhotoIdRef.current = null;
    saveSession(routeKey, { detailDismissed: true });
  }, [routeKey, saveSession]);

  const navigateDetail = useCallback(
    (direction: "prev" | "next") => {
      if (!detailPhoto) {
        return;
      }
      const currentIdx = photos.findIndex((p) => p.id === detailPhoto.id);
      const nextIdx = direction === "prev" ? currentIdx - 1 : currentIdx + 1;
      let nextPhoto: Photo | undefined = photos[nextIdx];
      if (currentIdx < 0) {
        const order = editingRef.current?.order ?? [];
        const previousIndex = order.indexOf(detailPhoto.id);
        const candidates =
          direction === "prev"
            ? order.slice(0, previousIndex).reverse()
            : order.slice(previousIndex + 1);
        const available = new Map(photos.map((photo) => [photo.id, photo]));
        nextPhoto = candidates
          .map((id) => available.get(id))
          .find((photo) => photo !== undefined);
      }
      if (!nextPhoto) {
        return;
      }
      editingRef.current = null;
      setDetailDismissed(false);
      setDetailPhoto(nextPhoto);
      detailPhotoIdRef.current = nextPhoto.id;
      prevSelectedIdRef.current = nextPhoto.id;
      userDismissedRef.current = false;
      saveSession(routeKey, { detailDismissed: false });
      onSelect(nextPhoto.id);
    },
    [detailPhoto, photos, routeKey, saveSession, onSelect]
  );

  /**
   * 直接显示指定照片的详情面板，绕过 actionPhotos 查找。
   * 用于序列详情面板中点击成员帧等场景，此时照片可能不在当前 actionPhotos 中。
   */
  const showPhoto = useCallback(
    (photo: Photo) => {
      editingRef.current = null;
      userDismissedRef.current = false;
      setDetailDismissed(false);
      prevSelectedIdRef.current = photo.id;
      detailPhotoIdRef.current = photo.id;
      setDetailPhoto(photo);
      saveSession(routeKey, { detailDismissed: false });
    },
    [routeKey, saveSession]
  );

  return {
    detailPhoto,
    detailDismissed,
    dismissDetail,
    navigateDetail,
    showPhoto,
  };
}
