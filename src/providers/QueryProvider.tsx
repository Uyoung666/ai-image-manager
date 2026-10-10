import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, useEffect } from "react";
import { subscribeAlbumRuleChanges } from "@/actions/albums";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      retry: 1,
    },
  },
});

export { queryClient };

export function QueryProvider({ children }: { children: ReactNode }) {
  useEffect(
    () =>
      subscribeAlbumRuleChanges(() => {
        // Cancel even an initial request so its old cover cannot refill cache.
        queryClient.cancelQueries({ queryKey: ["albums"] }).then(() => {
          queryClient.invalidateQueries({ queryKey: ["albums"] });
        });
      }),
    []
  );
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}
