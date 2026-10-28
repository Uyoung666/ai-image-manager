import { call } from "@orpc/server";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }));
vi.mock("electron", () => ({
  app: { getPath: () => "C:/AppData" },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock("@/services/registry", () => ({ registry: {} }));
vi.mock("@/services/settings-manager", () => ({
  getSetting: mocks.get,
  setSetting: mocks.set,
  getAllSettings: vi.fn(),
}));

import {
  getSearchHistoryPreferences,
  setSearchHistoryPreferences,
} from "@/ipc/settings/handlers";
import {
  SEARCH_HISTORY_LIMITS,
  SEARCH_HISTORY_PREFERENCES_KEY,
} from "@/types/search-history";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockReturnValue(null);
});
it("returns defaults for missing and malformed settings", async () => {
  expect(await call(getSearchHistoryPreferences, undefined)).toEqual({
    enabled: true,
    limit: 5,
  });
  mocks.get.mockReturnValue("{");
  expect(await call(getSearchHistoryPreferences, undefined)).toEqual({
    enabled: true,
    limit: 5,
  });
});
it.each(
  SEARCH_HISTORY_LIMITS
)("persists a validated limit %i", async (limit) => {
  expect(
    await call(setSearchHistoryPreferences, { enabled: false, limit })
  ).toEqual({ ok: true });
  expect(mocks.set).toHaveBeenCalledWith(
    SEARCH_HISTORY_PREFERENCES_KEY,
    JSON.stringify({ enabled: false, limit })
  );
});
it("preserves the old twenty-entry policy only for legacy profiles without saved preferences", async () => {
  expect(
    await call(getSearchHistoryPreferences, { legacyHistory: true })
  ).toEqual({
    enabled: true,
    limit: 20,
  });
  expect(mocks.set).toHaveBeenCalledWith(
    SEARCH_HISTORY_PREFERENCES_KEY,
    JSON.stringify({ enabled: true, limit: 20 })
  );
  mocks.set.mockClear();
  mocks.get.mockReturnValue(JSON.stringify({ enabled: false, limit: 5 }));
  expect(
    await call(getSearchHistoryPreferences, { legacyHistory: true })
  ).toEqual({
    enabled: false,
    limit: 5,
  });
  expect(mocks.set).not.toHaveBeenCalled();
});
it("rejects invalid payloads and propagates database write errors", async () => {
  await expect(
    call(setSearchHistoryPreferences, { enabled: true, limit: 999 } as never)
  ).rejects.toThrow();
  expect(mocks.set).not.toHaveBeenCalled();
  mocks.set.mockImplementationOnce(() => {
    throw new Error("database locked");
  });
  await expect(
    call(setSearchHistoryPreferences, { enabled: true, limit: 10 })
  ).rejects.toThrow("database locked");
});
