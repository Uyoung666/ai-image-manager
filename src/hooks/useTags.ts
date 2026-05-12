import { useQuery } from "@tanstack/react-query";
import { ipc } from "@/ipc/manager";
import type { Tag } from "@/types/photo";

export function useTags() {
  return useQuery<Tag[]>({
    queryKey: ["tags"],
    queryFn: async () => {
      const result = await ipc.client.photos.getTags({});
      return result as Tag[];
    },
    staleTime: 60_000,
  });
}
