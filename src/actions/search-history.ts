import { z } from "zod";
import { ipc } from "@/ipc/manager";
import {
  parseSearchHistoryPreferences,
  SEARCH_HISTORY_PREFERENCES_KEY,
  type SearchHistoryEntry,
  type SearchHistoryPreferences,
  searchHistoryId,
} from "@/types/search-history";

export const SEARCH_HISTORY_STORAGE_KEY = "search_history_v2";
export const LEGACY_SEARCH_HISTORY_KEY = "search_history";
export const SEARCH_HISTORY_CHANGED = "search-history-changed";
export const SEARCH_HISTORY_SAVE_FAILED = "search-history-save-failed";
let recordingRevision = 0;
let preferencesRevision = 0;
let pendingPreferences: Promise<SearchHistoryPreferences> | null = null;
function changed() {
  window.dispatchEvent(new Event(SEARCH_HISTORY_CHANGED));
}
function saveFailed() {
  window.dispatchEvent(new Event(SEARCH_HISTORY_SAVE_FAILED));
}
export function readSearchHistoryPreferences(): SearchHistoryPreferences {
  try {
    return parseSearchHistoryPreferences(
      localStorage.getItem(SEARCH_HISTORY_PREFERENCES_KEY)
    );
  } catch {
    return parseSearchHistoryPreferences(null);
  }
}

const EntryPayload = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("text"),
    query: z.string().trim().min(1),
    lastUsedAt: z.number().nonnegative(),
  }),
  z.object({
    kind: z.literal("image"),
    imagePath: z.string().min(1),
    lastUsedAt: z.number().nonnegative(),
  }),
]);
function historyItems(data: unknown, legacy: boolean): unknown[] {
  if (legacy) {
    return Array.isArray(data) ? data : [];
  }
  if (
    data &&
    typeof data === "object" &&
    "version" in data &&
    data.version === 2 &&
    "entries" in data &&
    Array.isArray(data.entries)
  ) {
    return data.entries;
  }
  return [];
}
function parseEntry(
  item: unknown,
  legacy: boolean,
  timestamp: number
): SearchHistoryEntry | null {
  const raw =
    legacy && typeof item === "string"
      ? { kind: "text", query: item, lastUsedAt: timestamp }
      : item;
  const parsed = EntryPayload.safeParse(raw);
  if (!parsed.success) {
    return null;
  }
  const entry = parsed.data;
  const value = entry.kind === "text" ? entry.query : entry.imagePath;
  if (!value.trim()) {
    return null;
  }
  return { ...entry, id: searchHistoryId(entry.kind, value) };
}
export function readSearchHistory(): SearchHistoryEntry[] {
  try {
    const current = localStorage.getItem(SEARCH_HISTORY_STORAGE_KEY);
    const data: unknown = JSON.parse(
      current ?? localStorage.getItem(LEGACY_SEARCH_HISTORY_KEY) ?? "[]"
    );
    const items = historyItems(data, current === null);
    const seen = new Set<string>();
    const entries: SearchHistoryEntry[] = [];
    for (const [index, item] of items.entries()) {
      const entry = parseEntry(item, current === null, items.length - index);
      if (entry && !seen.has(entry.id)) {
        entries.push(entry);
        seen.add(entry.id);
      }
    }
    return entries.slice(0, 100);
  } catch {
    return [];
  }
}
function writeSearchHistory(entries: SearchHistoryEntry[]): boolean {
  try {
    localStorage.setItem(
      SEARCH_HISTORY_STORAGE_KEY,
      JSON.stringify({ version: 2, entries })
    );
    localStorage.removeItem(LEGACY_SEARCH_HISTORY_KEY);
    changed();
    return true;
  } catch {
    saveFailed();
    return false;
  }
}
function applyPreferences(preferences: SearchHistoryPreferences) {
  try {
    localStorage.setItem(
      SEARCH_HISTORY_PREFERENCES_KEY,
      JSON.stringify(preferences)
    );
  } catch {
    saveFailed();
  }
  writeSearchHistory(readSearchHistory().slice(0, preferences.limit));
}
export function initializeSearchHistory(): Promise<SearchHistoryPreferences> {
  if (pendingPreferences) {
    return pendingPreferences;
  }
  const revision = preferencesRevision;
  pendingPreferences = (async () => {
    try {
      const preferences = await ipc.client.settings.getSearchHistoryPreferences(
        {
          legacyHistory:
            localStorage.getItem(SEARCH_HISTORY_STORAGE_KEY) === null &&
            localStorage.getItem(LEGACY_SEARCH_HISTORY_KEY) !== null,
        }
      );
      if (revision === preferencesRevision) {
        if (!preferences.enabled && readSearchHistoryPreferences().enabled) {
          recordingRevision++;
        }
        applyPreferences(preferences);
      }
    } catch {
      /* Keep cached policy and old history when IPC is unavailable. */
    }
    return readSearchHistoryPreferences();
  })().finally(() => {
    pendingPreferences = null;
  });
  return pendingPreferences;
}
export async function setSearchHistoryPreferences(
  preferences: SearchHistoryPreferences
) {
  preferencesRevision++;
  if (!preferences.enabled) {
    recordingRevision++;
  }
  await ipc.client.settings.setSearchHistoryPreferences(preferences);
  applyPreferences(preferences);
}
export function beginSearchHistoryRecording() {
  return {
    revision: readSearchHistoryPreferences().enabled ? recordingRevision : -1,
    ready: initializeSearchHistory(),
  };
}
export async function recordImageSearchHistory(
  imagePath: string,
  ticket: ReturnType<typeof beginSearchHistoryRecording>,
  isCurrent: () => boolean = () => true
) {
  await ticket.ready;
  if (!(isCurrent() && imagePath.trim())) {
    return;
  }
  addEntry(
    {
      kind: "image",
      imagePath,
      id: searchHistoryId("image", imagePath),
      lastUsedAt: Date.now(),
    },
    ticket.revision
  );
}
export async function recordTextSearchHistory(query: string) {
  if (!query.trim()) {
    return;
  }
  const ticket = beginSearchHistoryRecording();
  await ticket.ready;
  addEntry(
    {
      kind: "text",
      query: query.trim(),
      id: searchHistoryId("text", query),
      lastUsedAt: Date.now(),
    },
    ticket.revision
  );
}
function addEntry(entry: SearchHistoryEntry, revision: number) {
  const preferences = readSearchHistoryPreferences();
  if (revision !== recordingRevision || !preferences.enabled) {
    return;
  }
  writeSearchHistory(
    [
      entry,
      ...readSearchHistory().filter((item) => item.id !== entry.id),
    ].slice(0, preferences.limit)
  );
}
export function clearSearchHistory() {
  recordingRevision++;
  writeSearchHistory([]);
}
export function removeSearchHistoryEntry(id: string) {
  recordingRevision++;
  writeSearchHistory(readSearchHistory().filter((item) => item.id !== id));
}
