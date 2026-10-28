import { useEffect, useRef, useState } from "react";
import { searchStarterActions } from "@/actions/search-starters";
import { localSearchDay } from "@/services/search-starter-candidates";
import {
  rememberStarterBatch,
  selectStarterBatch,
} from "@/services/search-starter-rotation";
import type { ExifFilters } from "@/types/search";
import type {
  SearchStarter,
  SearchStarterInput,
  SearchStarterResponse,
} from "@/types/search-starters";
import { buildSearchFilterParams } from "@/utils/search-filter-params";

interface CachedStarters {
  batch: SearchStarter[];
  dirty?: boolean;
  fallback?: SearchStarterResponse;
  fallbackPending?: Promise<SearchStarterResponse>;
  pending?: Promise<SearchStarterResponse>;
  recent: SearchStarter[];
  recentCovers: number[];
  semantic?: SearchStarterResponse;
  validity?: string;
}
const cache = new Map<string, CachedStarters>();
const validityOf = (response: SearchStarterResponse) =>
  response.validity ?? response.revision;
const isSemantic = (item: SearchStarter) =>
  !item.kind || item.kind === "semantic";

function pool(
  entry: CachedStarters,
  semanticEnabled: boolean
): SearchStarter[] {
  return [
    ...(semanticEnabled && entry.semantic?.status === "ready"
      ? entry.semantic.candidates
      : []),
    ...(entry.fallback?.status === "ready" ? entry.fallback.candidates : []),
  ];
}

function installFallback(
  entry: CachedStarters,
  response: SearchStarterResponse
) {
  const validity = validityOf(response);
  if (entry.validity && entry.validity !== validity) {
    entry.batch = [];
    entry.semantic = undefined;
    entry.fallback = undefined;
  }
  entry.validity = validity;
  if (
    response.status === "ready" ||
    response.status === "empty" ||
    !entry.fallback
  ) {
    entry.dirty ||= entry.fallback?.revision !== response.revision;
    entry.fallback = response;
  }
}

function chooseBatch(
  entry: CachedStarters,
  semanticEnabled: boolean,
  previous: SearchStarter[] = []
) {
  entry.batch = selectStarterBatch(
    pool(entry, semanticEnabled),
    previous,
    entry.recent,
    entry.recentCovers
  );
  entry.recentCovers = [
    ...new Set([
      ...entry.batch.flatMap((item) => item.previewPhotoIds?.slice(0, 1) ?? []),
      ...entry.recentCovers,
    ]),
  ].slice(0, 48);
  entry.recent = rememberStarterBatch(entry.recent, entry.batch);
  entry.dirty = false;
}

function statusOf(
  entry: CachedStarters,
  semanticEnabled = true
): SearchStarterResponse["status"] {
  if (entry.batch.length) {
    return "ready";
  }
  if (
    entry.fallback?.emptyReason === "scope" ||
    entry.fallback?.emptyReason === "library"
  ) {
    return "empty";
  }
  if (!semanticEnabled && entry.fallback?.status !== "error") {
    return "unavailable";
  }
  return entry.semantic?.status ?? entry.fallback?.status ?? "empty";
}

function readEntry(key: string): CachedStarters {
  let entry = cache.get(key);
  if (!entry) {
    if (cache.size >= 16) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) {
        cache.delete(oldest);
      }
    }
    entry = { batch: [], recent: [], recentCovers: [] };
    cache.set(key, entry);
  }
  return entry;
}

async function installSemantic(
  entry: CachedStarters,
  response: SearchStarterResponse,
  recheck: () => Promise<SearchStarterResponse>,
  current: () => boolean
) {
  if (entry.validity && validityOf(response) !== entry.validity) {
    try {
      const fallback = await recheck();
      if (!current()) {
        return;
      }
      installFallback(entry, fallback);
    } catch {
      // A different eligibility snapshot cannot keep old cards if revalidation failed.
      if (current()) {
        entry.batch = [];
        entry.semantic = undefined;
        entry.fallback = failedResponse();
        entry.validity = undefined;
      }
      return;
    }
  }
  if (entry.validity && entry.validity !== validityOf(response)) {
    return;
  }
  entry.validity = validityOf(response);
  if (response.status === "ready" || response.status === "empty") {
    entry.dirty ||= entry.semantic?.revision !== response.revision;
    entry.semantic = response;
  } else if (response.status === "unavailable" || !entry.semantic) {
    entry.semantic = response;
    if (response.status === "unavailable") {
      entry.batch = entry.batch.filter((item) => !isSemantic(item));
    }
  }
}

function failedResponse(): SearchStarterResponse {
  return {
    candidates: [],
    day: localSearchDay(),
    revision: "",
    status: "error",
  };
}

export function clearSearchStarterCache(): void {
  cache.clear();
}

function displayLocale(language: string): SearchStarterInput["locale"] {
  if (language.startsWith("zh")) {
    return "zh";
  }
  if (language.startsWith("ja")) {
    return "ja";
  }
  return "en";
}

export function useSearchStarters({
  open,
  enabled,
  semanticEnabled = true,
  language,
  history,
  historyEnabled = true,
  filters,
  colorHex,
}: {
  open: boolean;
  enabled: boolean;
  semanticEnabled?: boolean;
  language: string;
  history: string[];
  historyEnabled?: boolean;
  filters: ExifFilters;
  colorHex?: string | null;
}) {
  const input: SearchStarterInput = {
    language: language.startsWith("zh") ? "zh" : "en",
    locale: displayLocale(language),
    history: (historyEnabled ? history : [])
      .filter((text) => typeof text === "string")
      .slice(0, 20)
      .map((text) => text.slice(0, 500)),
    filters: buildSearchFilterParams(filters),
    ...(colorHex ? { colorHex } : {}),
  };
  // Keep normal ranking updates stable, but isolate recommendations when history is disabled.
  const key = JSON.stringify([
    localSearchDay(),
    input.language,
    input.locale,
    input.filters,
    input.colorHex,
    historyEnabled,
  ]);
  const currentKey = useRef(key);
  currentKey.current = key;
  const mounted = useRef(false);
  const requestGeneration = useRef(0);
  const lastOpening = useRef({ key, open: false });
  const [state, setState] = useState(() => {
    const entry = cache.get(key);
    return {
      key,
      batch: entry?.batch ?? [],
      status: entry
        ? statusOf(entry, semanticEnabled)
        : ("empty" as SearchStarterResponse["status"]),
      emptyReason: entry?.fallback?.emptyReason,
      loading: enabled && !entry,
    };
  });
  const displayedRef = useRef(state.batch);
  displayedRef.current = state.batch;
  const options = useRef({ open, enabled, semanticEnabled, input });
  options.current = { open, enabled, semanticEnabled, input };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      requestGeneration.current++;
    };
  }, []);

  async function load(rotate = false) {
    const entry = readEntry(key);
    const generation = ++requestGeneration.current;
    const snapshot = options.current;
    const displayed = displayedRef.current;
    const current = () =>
      mounted.current &&
      currentKey.current === key &&
      generation === requestGeneration.current;
    let rotated = false;
    if (!snapshot.semanticEnabled) {
      entry.batch = entry.batch.filter((item) => !isSemantic(item));
    }
    const publish = (finished: boolean) => {
      if (!current()) {
        return;
      }
      if (entry.batch.length === 0 || (rotate && !rotated)) {
        chooseBatch(entry, snapshot.semanticEnabled, rotate ? displayed : []);
        rotated ||= rotate && entry.batch.length > 0;
      }
      const definitelyEmpty =
        entry.fallback?.emptyReason === "library" ||
        entry.fallback?.emptyReason === "scope";
      setState({
        key,
        batch: entry.batch,
        status: statusOf(entry, snapshot.semanticEnabled),
        emptyReason: entry.fallback?.emptyReason,
        loading: !(finished || definitelyEmpty) && entry.batch.length === 0,
      });
    };
    publish(false);

    const fallbackRequest = () => {
      entry.fallbackPending ??= searchStarterActions
        .fallbacks(snapshot.input)
        .finally(() => {
          entry.fallbackPending = undefined;
        });
      return entry.fallbackPending;
    };
    if (snapshot.semanticEnabled) {
      entry.pending ??= searchStarterActions.get(snapshot.input).finally(() => {
        entry.pending = undefined;
      });
    }
    // Attach rejection handling immediately; metadata and model requests are independent.
    const semanticTask = entry.pending?.then(
      (response) => ({ response }),
      () => ({ response: undefined })
    );
    try {
      const fallback = await fallbackRequest();
      if (!current()) {
        return;
      }
      installFallback(entry, fallback);
      publish(false);
    } catch {
      if (!entry.fallback && current()) {
        entry.fallback = failedResponse();
      }
    }
    const semantic = await semanticTask;
    if (!current()) {
      return;
    }
    const response = semantic?.response;
    if (response) {
      await installSemantic(entry, response, fallbackRequest, current);
    } else if (snapshot.semanticEnabled && !entry.semantic) {
      entry.semantic = failedResponse();
    }
    publish(true);
  }
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    const refresh = () => {
      if (options.current.enabled) {
        loadRef.current().catch(() => undefined);
      }
    };
    const onMessage = (event: MessageEvent) => {
      if (
        event.source === window &&
        ["ai-tags-done", "ai-embedding-done", "ai-status-changed"].includes(
          event.data?.channel
        )
      ) {
        refresh();
      }
    };
    window.addEventListener("tags-changed", refresh);
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("tags-changed", refresh);
      window.removeEventListener("message", onMessage);
    };
  }, []);

  useEffect(() => {
    requestGeneration.current++;
    const opening =
      open && (!lastOpening.current.open || lastOpening.current.key !== key);
    lastOpening.current = { key, open };
    if (!enabled || colorHex) {
      setState({
        key,
        batch: [],
        status: colorHex ? "color" : "unavailable",
        emptyReason: undefined,
        loading: false,
      });
      return;
    }
    const entry = readEntry(key);
    if (!semanticEnabled) {
      entry.batch = entry.batch.filter((item) => !isSemantic(item));
    }
    if (entry.dirty && opening) {
      chooseBatch(entry, semanticEnabled);
    }
    setState({
      key,
      batch: entry.batch,
      status: statusOf(entry, semanticEnabled),
      emptyReason: entry.fallback?.emptyReason,
      loading: !(entry.fallback || entry.semantic),
    });
    const timer = setTimeout(
      () => {
        loadRef.current().catch(() => undefined);
      },
      open ? 0 : 300
    );
    return () => {
      clearTimeout(timer);
      requestGeneration.current++;
    };
  }, [key, open, enabled, colorHex, semanticEnabled]);

  return {
    ...(state.key === key && enabled
      ? state
      : {
          batch: [],
          status: "empty" as const,
          emptyReason: undefined,
          loading: enabled,
        }),
    validity: cache.get(key)?.validity,
    refresh: () => (enabled ? loadRef.current(true) : Promise.resolve()),
  };
}
