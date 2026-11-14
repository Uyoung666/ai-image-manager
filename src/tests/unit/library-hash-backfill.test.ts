/** @vitest-environment node */
import { afterEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ query: vi.fn(() => []) }));
vi.mock("@/db", () => ({
  getDatabase: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({ limit: () => ({ all: state.query }) }),
        }),
      }),
    }),
  }),
}));
vi.mock("@/utils/logger", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn() }),
}));

import {
  requestLibraryHashBackfill,
  startLibraryHashBackfill,
  stopLibraryHashBackfill,
} from "@/services/library-moves";

afterEach(async () => {
  await stopLibraryHashBackfill();
  vi.useRealTimers();
  vi.clearAllMocks();
});

it("wakes an empty fingerprint queue immediately when an import adds work", async () => {
  vi.useFakeTimers();
  startLibraryHashBackfill(() => false);
  await vi.advanceTimersByTimeAsync(500);
  expect(state.query).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1000);
  expect(state.query).toHaveBeenCalledTimes(1);

  requestLibraryHashBackfill();
  requestLibraryHashBackfill();
  await vi.advanceTimersByTimeAsync(1);
  expect(state.query).toHaveBeenCalledTimes(2);

  await stopLibraryHashBackfill();
  requestLibraryHashBackfill();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(state.query).toHaveBeenCalledTimes(2);
});
