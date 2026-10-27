import { ipc } from "@/ipc/manager";
import type { SearchStarterInput } from "@/types/search-starters";
import { withTimeout } from "@/utils/with-timeout";

export const searchStarterActions = {
  fallbacks: (input: SearchStarterInput) =>
    withTimeout(
      ipc.client.photos.getSearchStarterFallbacks(input),
      5000,
      "search starter metadata"
    ),
  get: (input: SearchStarterInput) =>
    withTimeout(
      ipc.client.photos.getSearchStarters(input),
      20_000,
      "search starter themes"
    ),
};
