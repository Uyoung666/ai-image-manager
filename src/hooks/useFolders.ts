import { useQuery } from "@tanstack/react-query";
import { ipc } from "@/ipc/manager";
import type { Folder } from "@/types/photo";

export function useFolders() {
  return useQuery<Folder[]>({
    queryKey: ["folders"],
    queryFn: async () => {
      const result = await ipc.client.photos.getFolders({});
      return result as Folder[];
    },
    staleTime: 60_000,
  });
}
