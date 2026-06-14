import { useQuery } from "@tanstack/react-query";
import { ipc } from "@/ipc/manager";
import type { Tag } from "@/types/photo";

export function useTags(folderId?: number) {
  return useQuery<Tag[]>({
    queryKey: ["tags", { folderId: folderId ?? null }],
    queryFn: async () => {
      const result = await ipc.client.photos.getTags({
        folderId: folderId ?? undefined,
      });
      return result as Tag[];
    },
    staleTime: 60_000,
  });
}
