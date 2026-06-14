import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { ipc } from "@/ipc/manager";
import type { PhotoListResponse } from "@/types/photo";

const PAGE_SIZE = 100;

interface UsePhotosParams {
  enabled?: boolean;
  favoriteOnly?: boolean;
  folderId?: number | null;
  order?: "asc" | "desc";
  sort?: "name" | "date" | "size";
  tagId?: number | null;
  tagIds?: number[];
  tagMode?: "and" | "or";
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
  tagId,
  tagIds,
  tagMode = "or",
  favoriteOnly,
  sort = "date",
  order = "desc",
  enabled = true,
}: UsePhotosParams) {
  return useInfiniteQuery<PhotoListResponse>({
    queryKey: [
      "photos",
      {
        folderId: folderId ?? null,
        tagId: tagId ?? null,
        tagIds: tagIds ?? null,
        tagMode: tagMode ?? "or",
        favoriteOnly: favoriteOnly ?? false,
        sort,
        order,
      },
    ],
    queryFn: async ({ pageParam = 0 }) => {
      const result = await ipc.client.photos.listPhotos({
        folderId: folderId || undefined,
        tagId: tagIds?.length ? undefined : tagId || undefined,
        tagIds: tagIds?.length ? tagIds : undefined,
        tagMode: tagIds?.length ? tagMode : undefined,
        favoriteOnly: favoriteOnly || undefined,
        sort,
        order,
        offset: pageParam as number,
        limit: PAGE_SIZE,
      });
      return result as PhotoListResponse;
    },
    initialPageParam: 0,
    getNextPageParam: (lastPage) => {
      const nextOffset = lastPage.offset + lastPage.limit;
      return nextOffset < lastPage.total ? nextOffset : undefined;
    },
    placeholderData: keepPreviousData,
    // 30s staleTime: 足够避免翻页时的重复 COUNT 查询，又不会在导入完成后
    // 长期显示过时计数。导入完成时 import-queue 也会清 IPC 层 COUNT 缓存。
    staleTime: 30_000,
    enabled,
  });
}
