import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginSearchHistoryRecording,
  clearSearchHistory,
  initializeSearchHistory,
  LEGACY_SEARCH_HISTORY_KEY,
  readSearchHistory,
  readSearchHistoryPreferences,
  recordImageSearchHistory,
  recordTextSearchHistory,
  removeSearchHistoryEntry,
  SEARCH_HISTORY_SAVE_FAILED,
  SEARCH_HISTORY_STORAGE_KEY,
  setSearchHistoryPreferences,
} from "@/actions/search-history";
import {
  DEFAULT_SEARCH_HISTORY_PREFERENCES,
  parseSearchHistoryPreferences,
  SEARCH_HISTORY_LIMITS,
  SEARCH_HISTORY_PREFERENCES_KEY,
  type SearchHistoryPreferences,
  SearchHistoryPreferencesSchema,
} from "@/types/search-history";

const mocks = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }));
vi.mock("@/ipc/manager", () => ({
  ipc: {
    client: {
      settings: {
        getSearchHistoryPreferences: mocks.get,
        setSearchHistoryPreferences: mocks.set,
      },
    },
  },
}));
let preferences: SearchHistoryPreferences;
beforeEach(() => {
  localStorage.clear();
  preferences = { ...DEFAULT_SEARCH_HISTORY_PREFERENCES };
  mocks.get.mockReset().mockImplementation(async () => ({ ...preferences }));
  mocks.set.mockReset().mockImplementation((next) => {
    preferences = next;
    return Promise.resolve({ ok: true });
  });
});
afterEach(() => vi.restoreAllMocks());
const image = async (path: string) =>
  recordImageSearchHistory(path, beginSearchHistoryRecording());
describe("mixed search history", () => {
  it("migrates legacy entries with the preserved twenty-entry policy in their original order", async () => {
    mocks.get.mockResolvedValue({ enabled: true, limit: 20 });
    localStorage.setItem(
      LEGACY_SEARCH_HISTORY_KEY,
      JSON.stringify([
        " newest ",
        null,
        "second",
        "second",
        "third",
        "fourth",
        "fifth",
        "oldest",
      ])
    );
    await initializeSearchHistory();
    expect(
      readSearchHistory().map((e) => e.kind === "text" && e.query)
    ).toEqual(["newest", "second", "third", "fourth", "fifth", "oldest"]);
    expect(mocks.get).toHaveBeenCalledWith({ legacyHistory: true });
    expect(readSearchHistoryPreferences().limit).toBe(20);
    expect(localStorage.getItem(LEGACY_SEARCH_HISTORY_KEY)).toBeNull();
    expect(
      JSON.parse(localStorage.getItem(SEARCH_HISTORY_STORAGE_KEY) ?? "null")
        .version
    ).toBe(2);
  });
  it("keeps new profiles at five and does not treat v2 data as a legacy profile", async () => {
    await initializeSearchHistory();
    expect(mocks.get).toHaveBeenLastCalledWith({ legacyHistory: false });
    expect(readSearchHistoryPreferences().limit).toBe(5);
    localStorage.setItem(LEGACY_SEARCH_HISTORY_KEY, JSON.stringify(["old"]));
    await initializeSearchHistory();
    expect(mocks.get).toHaveBeenLastCalledWith({ legacyHistory: false });
  });
  it("never records an image started while history was off after re-enabling", async () => {
    await setSearchHistoryPreferences({ enabled: false, limit: 20 });
    const privateSearch = beginSearchHistoryRecording();
    await privateSearch.ready;
    await setSearchHistoryPreferences({ enabled: true, limit: 20 });
    await recordImageSearchHistory("D:/private.jpg", privateSearch);
    expect(readSearchHistory()).toEqual([]);
  });
  it.each(
    SEARCH_HISTORY_LIMITS
  )("enforces a shared limit of %i", async (limit) => {
    await setSearchHistoryPreferences({ enabled: true, limit });
    for (let i = 0; i < limit + 1; i++) {
      await recordTextSearchHistory(`search ${i}`);
    }
    await image("D:/image.jpg");
    expect(readSearchHistory()).toHaveLength(limit);
    expect(readSearchHistory()[0].kind).toBe("image");
  });
  it("deduplicates trimmed text and normalized Windows paths but keeps same filenames from different folders", async () => {
    await setSearchHistoryPreferences({ enabled: true, limit: 10 });
    await recordTextSearchHistory(" sea ");
    await image("D:/one/reference.jpg");
    await image("D:/two/reference.jpg");
    await recordTextSearchHistory("sea");
    await image("d:\\ONE\\reference.jpg");
    expect(readSearchHistory()).toHaveLength(3);
    expect(readSearchHistory().map((e) => e.kind)).toEqual([
      "image",
      "text",
      "image",
    ]);
  });
  it("pauses writes and reordering while allowing existing entries to be removed", async () => {
    await recordTextSearchHistory("first");
    await image("D:/second.jpg");
    await setSearchHistoryPreferences({ enabled: false, limit: 5 });
    const before = readSearchHistory();
    await recordTextSearchHistory("first");
    await image("D:/third.jpg");
    expect(readSearchHistory()).toEqual(before);
    removeSearchHistoryEntry(before[0].id);
    expect(readSearchHistory()).toEqual([before[1]]);
    await setSearchHistoryPreferences({ enabled: true, limit: 5 });
    await recordTextSearchHistory("new");
    expect(readSearchHistory()).toHaveLength(2);
  });
  it("only trims after the setting save succeeds and cannot restore trimmed records", async () => {
    await setSearchHistoryPreferences({ enabled: true, limit: 10 });
    for (let i = 0; i < 8; i++) {
      await recordTextSearchHistory(String(i));
    }
    mocks.set.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(
      setSearchHistoryPreferences({ enabled: true, limit: 5 })
    ).rejects.toThrow();
    expect(readSearchHistory()).toHaveLength(8);
    expect(readSearchHistoryPreferences().limit).toBe(10);
    await setSearchHistoryPreferences({ enabled: true, limit: 5 });
    await setSearchHistoryPreferences({ enabled: true, limit: 10 });
    expect(readSearchHistory()).toHaveLength(5);
  });
  it("does not resurrect an in-flight image after clearing or disabling then enabling", async () => {
    const cleared = beginSearchHistoryRecording();
    await cleared.ready;
    clearSearchHistory();
    await recordImageSearchHistory("D:/old.jpg", cleared);
    expect(readSearchHistory()).toEqual([]);
    const disabled = beginSearchHistoryRecording();
    await disabled.ready;
    await setSearchHistoryPreferences({ enabled: false, limit: 5 });
    await setSearchHistoryPreferences({ enabled: true, limit: 5 });
    await recordImageSearchHistory("D:/old.jpg", disabled);
    expect(readSearchHistory()).toEqual([]);
  });
  it("discards superseded images even if preferences finish loading later", async () => {
    const ticket = beginSearchHistoryRecording();
    await recordImageSearchHistory("D:/old.jpg", ticket, () => false);
    expect(readSearchHistory()).toEqual([]);
  });
  it("keeps legacy data and signals a storage error when migration cannot be written", async () => {
    localStorage.setItem(LEGACY_SEARCH_HISTORY_KEY, JSON.stringify(["keep"]));
    const error = vi.fn();
    window.addEventListener(SEARCH_HISTORY_SAVE_FAILED, error);
    const original = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      key,
      value
    ) {
      if (key === SEARCH_HISTORY_STORAGE_KEY) {
        throw new Error("quota");
      }
      original.call(this, key, value);
    });
    await initializeSearchHistory();
    expect(localStorage.getItem(LEGACY_SEARCH_HISTORY_KEY)).toContain("keep");
    await expect(
      recordTextSearchHistory("still searches")
    ).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();
    window.removeEventListener(SEARCH_HISTORY_SAVE_FAILED, error);
  });
  it("never restores old-key entries after clear, even if the old key reappears", () => {
    localStorage.setItem(LEGACY_SEARCH_HISTORY_KEY, JSON.stringify(["old"]));
    clearSearchHistory();
    localStorage.setItem(LEGACY_SEARCH_HISTORY_KEY, JSON.stringify(["old"]));
    expect(readSearchHistory()).toEqual([]);
  });
  it("ignores malformed history and invalid preferences", () => {
    for (const raw of ["{", "{}", "null", "42"]) {
      localStorage.setItem(SEARCH_HISTORY_STORAGE_KEY, raw);
      expect(readSearchHistory()).toEqual([]);
    }
    expect(
      parseSearchHistoryPreferences('{"enabled":true,"limit":999}')
    ).toEqual(DEFAULT_SEARCH_HISTORY_PREFERENCES);
    expect(parseSearchHistoryPreferences("{")).toEqual(
      DEFAULT_SEARCH_HISTORY_PREFERENCES
    );
    expect(
      SearchHistoryPreferencesSchema.safeParse({ enabled: "true", limit: 5 })
        .success
    ).toBe(false);
  });
  it("does not apply a delayed settings read over a new user choice", async () => {
    let resolve!: (value: SearchHistoryPreferences) => void;
    mocks.get.mockReturnValueOnce(
      new Promise<SearchHistoryPreferences>((done) => {
        resolve = done;
      })
    );
    const loading = initializeSearchHistory();
    await setSearchHistoryPreferences({ enabled: false, limit: 50 });
    resolve({ enabled: true, limit: 5 });
    await loading;
    expect(readSearchHistoryPreferences()).toEqual({
      enabled: false,
      limit: 50,
    });
    expect(localStorage.getItem(SEARCH_HISTORY_PREFERENCES_KEY)).toContain(
      "50"
    );
  });
});
