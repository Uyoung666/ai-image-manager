import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { photoSequenceActions } from "@/actions/photo-sequences";
import type { useSidebarFilter } from "@/contexts/SidebarFilterContext";
import type { PhotoSequence } from "@/types/photo-sequence";
import {
  getStableSearchAppendIds,
  isSequenceSourceReady,
} from "@/utils/gallery-view-state";

interface SequenceDataSource {
  key: string;
  photoIds: number[];
  refresh: number;
  searchGeneration: number | null;
}
export interface PreparedSearchSequences {
  generation: number;
  photoIds: number[];
  sequences: PhotoSequence[];
}
interface Options {
  filter: Pick<
    ReturnType<typeof useSidebarFilter>,
    "activeFolderId" | "activeTagIds" | "favoriteOnly" | "tagMode"
  >;
  isSearching: boolean;
  preparedSearchSequences?: PreparedSearchSequences | null;
  searchResultGeneration: number;
  searchResultSourceKey: string | null;
  sequencePhotoIds: number[];
}
/** Full-gallery browse scope and generation-aware search append remain distinct. */
export function useHomeSequenceQuery({
  filter,
  isSearching,
  searchResultGeneration,
  searchResultSourceKey,
  sequencePhotoIds,
  preparedSearchSequences,
}: Options) {
  const { t } = useTranslation();

  const [storedDataSource, setSequenceDataSource] =
    useState<SequenceDataSource | null>(null);

  const sequenceDataSourceRef = useRef(storedDataSource);
  const appliedPreparedRef = useRef<{
    prepared: PreparedSearchSequences;
    key: string;
    retry: number;
  } | null>(null);

  const [sequenceRetry, setSequenceRetry] = useState(0);

  const [storedSequences, setSequences] = useState<PhotoSequence[]>([]);

  const [sequenceError, setSequenceError] = useState<string | null>(null);

  const [gallerySequenceCount, setGallerySequenceCount] = useState(0);

  const [sequenceRefresh, setSequenceRefresh] = useState(0);

  const sequenceScopeKey = isSearching
    ? `search:${searchResultSourceKey ?? "pending"}`
    : `gallery:${filter.activeFolderId ?? "all"}:${(filter.activeTagIds ?? []).join(",")}:${filter.favoriteOnly ? "fav" : "all"}:${filter.tagMode}`;

  const sequenceQuerySourceKey = isSearching
    ? `${sequenceScopeKey}:sequence:${sequenceRefresh}:${sequencePhotoIds.join(",")}`
    : `${sequenceScopeKey}:sequence:${sequenceRefresh}`;

  const prepared =
    isSearching &&
    preparedSearchSequences &&
    preparedSearchSequences.generation === searchResultGeneration &&
    appliedPreparedRef.current?.prepared !== preparedSearchSequences &&
    preparedSearchSequences.photoIds.length === sequencePhotoIds.length &&
    preparedSearchSequences.photoIds.every(
      (id, index) => sequencePhotoIds[index] === id
    )
      ? preparedSearchSequences
      : null;
  const sequenceDataSource = prepared
    ? {
        key: sequenceQuerySourceKey,
        photoIds: sequencePhotoIds,
        refresh: sequenceRefresh,
        searchGeneration: searchResultGeneration,
      }
    : storedDataSource;
  const sequences = prepared?.sequences ?? storedSequences;
  sequenceDataSourceRef.current = sequenceDataSource;

  useLayoutEffect(() => {
    if (prepared && sequenceDataSource) {
      appliedPreparedRef.current = {
        prepared,
        key: sequenceQuerySourceKey,
        retry: sequenceRetry,
      };
      setSequences(prepared.sequences);
      setSequenceDataSource(sequenceDataSource);
      setSequenceError(null);
    }
  }, [prepared, sequenceDataSource, sequenceQuerySourceKey, sequenceRetry]);

  const sequenceViewReady = useMemo(() => {
    if (!sequenceDataSource) {
      return false;
    }
    return isSequenceSourceReady({
      currentGeneration: isSearching ? searchResultGeneration : null,
      currentIds: sequencePhotoIds,
      currentSourceKey: sequenceQuerySourceKey,
      isSearching,
      previousGeneration: sequenceDataSource.searchGeneration,
      previousIds: sequenceDataSource.photoIds,
      previousSourceKey: sequenceDataSource.key,
      refreshUnchanged: sequenceDataSource.refresh === sequenceRefresh,
    });
  }, [
    isSearching,
    searchResultGeneration,
    sequenceDataSource,
    sequencePhotoIds,
    sequenceQuerySourceKey,
    sequenceRefresh,
  ]);

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: initial resolution, prepared refreshes and incremental appends share one cancellation boundary.
  useEffect(() => {
    let cancelled = false;
    const applied = appliedPreparedRef.current;
    if (
      preparedSearchSequences &&
      applied?.prepared === preparedSearchSequences &&
      applied.key === sequenceQuerySourceKey &&
      applied.retry === sequenceRetry
    ) {
      return;
    }
    setSequenceError(null);
    // In browse mode, sequence cards must be resolved against the full filtered
    // gallery rather than just the loaded photo page. Otherwise a page made up
    // entirely of one collapsed sequence can hide later sequences in the same
    // folder until pagination happens to reach one of their members.
    const useGalleryScope = !isSearching;
    const searchKey = isSearching ? String(searchResultGeneration) : "";
    const completedSource = sequenceDataSourceRef.current;
    const preserveCommitted = completedSource?.key.startsWith(
      `${sequenceScopeKey}:sequence:`
    );
    const previousIds = completedSource?.photoIds ?? [];
    const refreshUnchanged = completedSource?.refresh === sequenceRefresh;
    const appendedPhotoIds = getStableSearchAppendIds({
      currentIds: sequencePhotoIds,
      currentSearchKey: searchKey,
      isSearching,
      previousIds,
      previousSearchKey: completedSource?.searchGeneration?.toString() ?? "",
      refreshUnchanged,
    });
    const isSearchAppend = appendedPhotoIds !== null;
    const requestedPhotoIds = appendedPhotoIds ?? sequencePhotoIds;

    if (!useGalleryScope && sequencePhotoIds.length === 0) {
      setSequences([]);
      setSequenceDataSource({
        key: sequenceQuerySourceKey,
        photoIds: sequencePhotoIds,
        refresh: sequenceRefresh,
        searchGeneration: isSearching ? searchResultGeneration : null,
      });
      return;
    }
    photoSequenceActions
      .list(
        useGalleryScope
          ? {
              scope: "gallery",
              folderId: filter.activeFolderId ?? undefined,
              favoriteOnly: filter.favoriteOnly || undefined,
              tagIds:
                filter.activeTagIds.length > 0
                  ? filter.activeTagIds
                  : undefined,
              tagMode: filter.tagMode,
            }
          : { photoIds: requestedPhotoIds, scope: "members" }
      )
      .then((result) => {
        if (!cancelled) {
          if (isSearchAppend) {
            setSequences((current) => {
              const merged = new Map(
                current.map((sequence) => [sequence.id, sequence])
              );
              for (const sequence of result as PhotoSequence[]) {
                const previous = merged.get(sequence.id);
                if (!previous) {
                  merged.set(sequence.id, sequence);
                  continue;
                }
                const matchedIds = new Set([
                  ...(previous.matchedPhotoIds ?? []),
                  ...(sequence.matchedPhotoIds ?? []),
                ]);
                const orderedMatchedIds = (
                  sequence.memberPhotoIds ??
                  previous.memberPhotoIds ??
                  []
                ).filter((id) => matchedIds.has(id));
                merged.set(sequence.id, {
                  ...previous,
                  ...sequence,
                  matchedCount: orderedMatchedIds.length,
                  matchedPhoto: previous.matchedPhoto ?? sequence.matchedPhoto,
                  matchedPhotoIds: orderedMatchedIds,
                });
              }
              return [...merged.values()];
            });
          } else {
            setSequences(result as PhotoSequence[]);
          }
          if (useGalleryScope) {
            setGallerySequenceCount(result.length);
          }
          setSequenceError(null);
          setSequenceDataSource({
            key: sequenceQuerySourceKey,
            photoIds: sequencePhotoIds,
            refresh: sequenceRefresh,
            searchGeneration: isSearching ? searchResultGeneration : null,
          });
        }
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        if (!(isSearchAppend || preserveCommitted)) {
          setSequences([]);
          if (useGalleryScope) {
            setGallerySequenceCount(0);
          }
        }
        setSequenceError(t("loadFailedRetry"));
        if (!(isSearchAppend || preserveCommitted)) {
          setSequenceDataSource({
            key: sequenceQuerySourceKey,
            photoIds: [],
            refresh: sequenceRefresh,
            searchGeneration: isSearching ? searchResultGeneration : null,
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [
    filter.activeFolderId,
    filter.activeTagIds,
    filter.favoriteOnly,
    filter.tagMode,
    isSearching,
    preparedSearchSequences,
    searchResultGeneration,
    sequencePhotoIds,
    sequenceQuerySourceKey,
    sequenceScopeKey,
    sequenceRefresh,
    sequenceRetry,
    t,
  ]);

  const sequenceCount = isSearching ? sequences.length : gallerySequenceCount;
  return {
    sequenceDataSource,
    setSequenceDataSource,
    sequenceDataSourceRef,
    sequenceRetry,
    setSequenceRetry,
    sequences,
    setSequences,
    sequenceError,
    setSequenceError,
    gallerySequenceCount,
    setGallerySequenceCount,
    sequenceRefresh,
    setSequenceRefresh,
    sequenceScopeKey,
    sequenceQuerySourceKey,
    sequenceViewReady,
    sequenceCount,
  };
}
