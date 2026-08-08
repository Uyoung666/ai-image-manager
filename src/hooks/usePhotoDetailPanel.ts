import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { useBrowseSession } from "@/contexts/BrowseSessionContext";

interface Photo {
  id: number;
  [key: string]: any;
}

interface UsePhotoDetailPanelReturn {
  detailDismissed: boolean;
  detailPhoto: Photo | null;
  dismissDetail: () => void;
  navigateDetail: (direction: "prev" | "next") => void;
  showPhoto: (photo: Photo) => void;
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
  onSelect: (id: number) => void
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

  // 同步 selectedIds → detailPhoto
  // 规则：
  // 1. 选了不同照片 → 总是打开面板（重置 dismissed）
  // 2. 选了相同照片 + 未 dismissed → 保持打开
  // 3. 选了相同照片 + 已 dismissed → 重新打开（用户主动再次点击）
  // 4. 多选或无选中 → 关闭面板
  //
  // 注意：detailDismissed 和 detailPhoto 不在依赖数组中。
  // 它们由本 effect 输出（setState），通过 ref 解耦避免循环。
  useLayoutEffect(() => {
    if (selectedIds.size === 1) {
      const id = selectedIds.values().next().value as number;
      if (id !== prevSelectedIdRef.current) {
        // 规则 1：不同照片，总是打开
        userDismissedRef.current = false;
        setDetailDismissed(false);
        prevSelectedIdRef.current = id;
        saveSession(routeKey, { detailDismissed: false });
        const photo = photos.find((p) => p.id === id);
        setDetailPhoto(photo ?? null);
        detailPhotoIdRef.current = photo?.id ?? null;
      } else if (userDismissedRef.current) {
        // 规则 3：相同照片但用户已主动 dismiss → 用户再次点击同一照片才重新打开
        userDismissedRef.current = false;
        setDetailDismissed(false);
        saveSession(routeKey, { detailDismissed: false });
        const photo = photos.find((p) => p.id === id);
        setDetailPhoto(photo ?? null);
        detailPhotoIdRef.current = photo?.id ?? null;
      } else {
        // 规则 2：相同照片，保持打开，仅在 photo 对象变化时更新引用
        const photo = photos.find((p) => p.id === id);
        if (photo && photo.id !== detailPhotoIdRef.current) {
          setDetailPhoto(photo);
          detailPhotoIdRef.current = photo.id;
        }
      }
    } else if (selectedIds.size === 0) {
      // 规则 4：无选中 → 关闭
      if (detailPhotoIdRef.current !== null) {
        setDetailPhoto(null);
        detailPhotoIdRef.current = null;
      }
      prevSelectedIdRef.current = null;
      userDismissedRef.current = false;
    }
  }, [selectedIds, photos, routeKey, saveSession]);

  const dismissDetail = useCallback(() => {
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
      if (currentIdx < 0) {
        return;
      }
      const nextIdx = direction === "prev" ? currentIdx - 1 : currentIdx + 1;
      if (nextIdx < 0 || nextIdx >= photos.length) {
        return;
      }
      const nextPhoto = photos[nextIdx];
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
