import { useQuery } from "@tanstack/react-query";
import { ipc } from "@/ipc/manager";
import type { AiStatus } from "@/types/photo";

export function useAiStatus() {
  return useQuery<AiStatus>({
    queryKey: ["aiStatus"],
    queryFn: async () => {
      const result = await ipc.client.photos.getAiStatus({});
      return result as AiStatus;
    },
    refetchInterval: (query) => {
      const data = query.state.data;
      return data?.isEmbedding ? 3000 : 30_000;
    },
  });
}
