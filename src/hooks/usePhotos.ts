import {
  isServer,
  keepPreviousData,
  useInfiniteQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { photoListingActions } from "@/actions/photo-listing";
import { useScrollPosition } from "@/contexts/ScrollPositionContext";
import type { PhotoListResponse } from "@/types/photo";
import {
  galleryContext,
  getGalleryDataVersion,
  subscribeGalleryData,
} from "@/utils/gallery-data-source";
import { recordGalleryPerf } from "@/utils/gallery-perf";
import { observeGalleryQuery } from "@/utils/gallery-query-timing";

const PAGE_SIZE = 100;

function isExpiredGalleryCursor(error: Error & { code?: unknown }): boolean {
  return (
    error.code === "GALLERY_CURSOR_EXPIRED" ||
    error.message.includes("GALLERY_CURSOR_EXPIRED")
  );
}

interface UsePhotosParams {
  enabled?: boolean;
  favoriteOnly?: boolean;
  folderId?: number | null;
  order?: "asc" | "desc";
  sort?: "name" | "date" | "size";
  tagId?: number | null;
  tagIds?: number[];
  tagMode?: "and" | "or";
  ungroupedOnly?: boolean;
}

/**
 * 分页照片查询 Hook，封装 TanStack Query useInfiniteQuery。
 *
 * 关键返回值：
 * - `isPlaceholderData`: 当 queryKey 变化后、新数据到达前为 true。
 *   此时展示的是 keepPreviousData 保留的旧缓存数据，不可用于滚动位置恢复。
 *   下游必须在 `isPlaceholderData === false` 时才允许执行滚动恢复和锚点调整。
 */
export function usePhotos({
  folderId,
  ungroupedOnly = false,
  tagId,
  tagIds,
  tagMode = "or",
  favoriteOnly,
  sort = "date",
  order = "desc",
  enabled = true,
}: UsePhotosParams) {
  const queryClient = useQueryClient();
  const { getScrollPosition, saveScrollPosition } = useScrollPosition();
  const restoreKey = `home-${[folderId ?? "all", (tagIds ?? []).join(","), favoriteOnly ? "fav" : "", sort, order].filter(Boolean).join("-")}`;
  const cacheVersion = useSyncExternalStore(
    subscribeGalleryData,
    getGalleryDataVersion
  );
  const queryKey = useMemo(
    () => [
      "photos",
      {
        folderId: folderId ?? null,
        ungroupedOnly,
        tagId: tagId ?? null,
        tagIds: tagIds ?? null,
        tagMode: tagMode ?? "or",
        favoriteOnly: favoriteOnly ?? false,
        sort,
        order,
      },
    ],
    [folderId, ungroupedOnly, tagId, tagIds, tagMode, favoriteOnly, sort, order]
  );
  const defaultRetry = queryClient.defaultQueryOptions({ queryKey }).retry;
  const result = useInfiniteQuery<
    PhotoListResponse & { nextCursor?: string | null; revision?: number }
  >({
    queryKey,
    retry: (failureCount, error) => {
      if (isExpiredGalleryCursor(error)) {
        return false;
      }
      if (typeof defaultRetry === "function") {
        return defaultRetry(failureCount, error);
      }
      return (
        defaultRetry === true ||
        failureCount <
          (defaultRetry === false ? 0 : (defaultRetry ?? (isServer ? 0 : 3)))
      );
    },
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: initial restoration can hydrate a deep anchor without retaining the complete prefix records.
    queryFn: async ({ pageParam = null, signal }) => {
      const params = {
        folderId: folderId || undefined,
        ungroupedOnly: ungroupedOnly || undefined,
        tagId: tagIds?.length ? undefined : tagId || undefined,
        tagIds: tagIds?.length ? tagIds : undefined,
        tagMode: tagIds?.length ? tagMode : undefined,
        favoriteOnly: favoriteOnly || undefined,
        sort,
        order,
        limit: PAGE_SIZE,
      };
      const started = performance.now();
      const page = await photoListingActions.page({
        ...params,
        cursor: pageParam as string | null,
      });
      signal.throwIfAborted();
      observeGalleryQuery(performance.now() - started);
      recordGalleryPerf("galleryQueryMs", performance.now() - started);
      recordGalleryPerf("gallerySqlMs", page.queryMs);
      const source = galleryContext(
        `${JSON.stringify(params)}:${params.favoriteOnly ? page.revision : page.geometryRevision}`,
        photoListingActions.byIds
      );
      const saved = getScrollPosition(restoreKey)?.anchor;
      if (
        !pageParam &&
        saved &&
        saved.itemId > 0 &&
        (saved.estimatedGlobalIndex ?? 0) >= PAGE_SIZE * 2
      ) {
        const prefix = await photoListingActions.layoutPrefix({
          ...params,
          targetId: saved.itemId,
          fallbackIds: [saved.nextPhotoId, saved.previousPhotoId].filter(
            (id): id is number => id !== undefined && id > 0
          ),
          fallbackIndex: Math.min(
            saved.estimatedGlobalIndex ?? 0,
            Math.max(0, page.total - 1)
          ),
        });
        signal.throwIfAborted();
        if (prefix && prefix.revision === page.revision) {
          const restoredItems = source.append([
            ...prefix.items,
            ...prefix.tailItems,
          ]);
          if (prefix.anchorId !== saved.itemId) {
            const position = getScrollPosition(restoreKey);
            if (position) {
              saveScrollPosition(restoreKey, position.scrollTop, {
                ...saved,
                itemId: prefix.anchorId,
                queryVersion: prefix.revision,
              });
            }
          }
          await source.ensureRange(
            Math.max(0, restoredItems.length - PAGE_SIZE * 2),
            restoredItems.length - 1
          );
          signal.throwIfAborted();
          return {
            ...page,
            items: restoredItems,
            nextCursor:
              restoredItems.length < page.total ? prefix.nextCursor : null,
            offset: 0,
            limit: PAGE_SIZE,
          };
        }
      }
      const items = source.append(
        page.items,
        page.items as PhotoListResponse["items"]
      );
      return {
        ...page,
        items,
        offset: source.getIndex(items[0]?.id) ?? 0,
        limit: PAGE_SIZE,
      };
    },
    structuralSharing: false,
    initialPageParam: null,
    getNextPageParam: (lastPage) => {
      return lastPage.nextCursor ?? undefined;
    },
    placeholderData: keepPreviousData,
    // 30s staleTime: 足够避免翻页时的重复 COUNT 查询，又不会在导入完成后
    // 长期显示过时计数。导入完成时 import-queue 也会清 IPC 层 COUNT 缓存。
    staleTime: 30_000,
    enabled,
  });
  const data = useMemo(
    () => (result.data ? { ...result.data, cacheVersion } : undefined),
    [result.data, cacheVersion]
  );
  useEffect(() => {
    if (result.error && isExpiredGalleryCursor(result.error)) {
      queryClient.resetQueries({
        queryKey,
        exact: true,
      });
    }
  }, [result.error, queryClient, queryKey]);
  return { ...result, data };
}
