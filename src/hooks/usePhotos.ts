import { useInfiniteQuery } from "@tanstack/react-query";
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
}

export function usePhotos({
  folderId,
  tagId,
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
        favoriteOnly: favoriteOnly ?? false,
        sort,
        order,
      },
    ],
    queryFn: async ({ pageParam = 0 }) => {
      const result = await ipc.client.photos.listPhotos({
        folderId: folderId || undefined,
        tagId: tagId || undefined,
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
    enabled,
  });
}
