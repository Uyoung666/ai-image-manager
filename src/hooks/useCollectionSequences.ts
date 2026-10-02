import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { photoSequenceActions } from "@/actions/photo-sequences";
import { useSequenceDetailRefresh } from "@/hooks/useSequenceDetailRefresh";
import type { Photo } from "@/types/photo";
import type {
  PhotoSequence,
  PhotoSequenceDetail,
  SequenceOrderChange,
} from "@/types/photo-sequence";

export type CollectionSequenceMode = "photos" | "sequences";

export function getSequenceMemberIds(sequences: PhotoSequence[]): number[] {
  return [
    ...new Set(
      sequences.flatMap(
        (sequence) => sequence.matchedPhotoIds ?? sequence.memberPhotoIds ?? []
      )
    ),
  ];
}

export function shouldShowSequenceEmptyState({
  mode,
  sequenceCount,
  sequencesLoaded,
}: {
  mode: CollectionSequenceMode;
  sequenceCount: number;
  sequencesLoaded: boolean;
}) {
  return mode === "sequences" && sequencesLoaded && sequenceCount === 0;
}

const EMPTY_IDS: number[] = [];
const EMPTY_SEQUENCES: PhotoSequence[] = [];

function readMode(storageKey: string): CollectionSequenceMode {
  try {
    return localStorage.getItem(storageKey) === "sequences"
      ? "sequences"
      : "photos";
  } catch {
    return "photos";
  }
}

function scopedIds(sequence: PhotoSequence): number[] {
  return sequence.matchedPhotoIds ?? sequence.memberPhotoIds ?? EMPTY_IDS;
}

function scopeDetail(
  detail: PhotoSequenceDetail,
  memberIds: number[]
): PhotoSequenceDetail {
  const idSet = new Set(memberIds);
  const members = detail.members.filter((photo) => idSet.has(photo.id));
  const representativePhotoId =
    detail.representativePhotoId != null &&
    idSet.has(detail.representativePhotoId)
      ? detail.representativePhotoId
      : (members[0]?.id ?? null);
  return {
    ...detail,
    frameCount: members.length,
    members,
    representativePhotoId,
  };
}

function reorderMembers<T extends { id: number }>(
  members: readonly T[],
  orderedIds: readonly number[]
): T[] {
  const membersById = new Map(members.map((member) => [member.id, member]));
  const seen = new Set<number>();
  const ordered = orderedIds.flatMap((id) => {
    const member = membersById.get(id);
    if (!member || seen.has(id)) {
      return [];
    }
    seen.add(id);
    return [member];
  });
  return ordered.concat(members.filter((member) => !seen.has(member.id)));
}

function applySequenceOrderToSummary(
  sequence: PhotoSequence,
  change: SequenceOrderChange
): PhotoSequence {
  const next = { ...sequence, source: "manual" as const, userLocked: true };
  if (sequence.memberPhotoIds) {
    const memberIds = new Set(sequence.memberPhotoIds);
    next.memberPhotoIds = change.orderedMemberIds.filter((id) =>
      memberIds.has(id)
    );
  }
  if (sequence.matchedPhotoIds) {
    const matchedIds = new Set(sequence.matchedPhotoIds);
    next.matchedPhotoIds = change.orderedMemberIds.filter((id) =>
      matchedIds.has(id)
    );
    next.matchedCount = next.matchedPhotoIds.length;
  }
  return next;
}

export function useCollectionSequences({
  photos,
  storageKey,
  onClearSelection,
  onRemoveSelection,
}: {
  photos: Photo[];
  storageKey: string;
  onClearSelection: () => void;
  onRemoveSelection: (ids: number[]) => void;
}) {
  const [mode, setModeState] = useState<CollectionSequenceMode>(() =>
    readMode(storageKey)
  );
  const [sequences, setSequences] = useState<PhotoSequence[]>([]);
  const [sequencesError, setSequencesError] = useState(false);
  const [loadedSequenceRequestKey, setLoadedSequenceRequestKey] = useState<
    string | null
  >(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [expandedSequence, setExpandedSequence] =
    useState<PhotoSequenceDetail | null>(null);
  const [expandedSequenceComplete, setExpandedSequenceComplete] =
    useState<PhotoSequenceDetail | null>(null);
  const [expandingSequenceId, setExpandingSequenceId] = useState<number | null>(
    null
  );
  const [selectedSequence, setSelectedSequence] =
    useState<PhotoSequenceDetail | null>(null);
  const [openSequence, setOpenSequence] = useState<PhotoSequenceDetail | null>(
    null
  );
  const requestRef = useRef(0);
  const detailsRequestRef = useRef(0);
  const detailCacheRef = useRef(new Map<number, PhotoSequenceDetail>());
  const [loadedSequenceScopeKey, setLoadedSequenceScopeKey] = useState<
    string | null
  >(null);

  const updateSequenceOrder = useCallback((change: SequenceOrderChange) => {
    const applyOrder = (detail: PhotoSequenceDetail) => ({
      ...detail,
      source: "manual" as const,
      userLocked: true,
      members: reorderMembers(detail.members, change.orderedMemberIds),
    });
    setExpandedSequence((current) =>
      current?.id === change.sequenceId ? applyOrder(current) : current
    );
    setExpandedSequenceComplete((current) =>
      current?.id === change.sequenceId ? applyOrder(current) : current
    );
    const cached = detailCacheRef.current.get(change.sequenceId);
    if (cached) {
      detailCacheRef.current.set(change.sequenceId, applyOrder(cached));
    }
    setSequences((current) =>
      current.map((sequence) =>
        sequence.id === change.sequenceId
          ? applySequenceOrderToSummary(sequence, change)
          : sequence
      )
    );
  }, []);

  // Ownership depends on membership, not object identity or gallery sorting.
  const photoIdsKey = [...new Set(photos.map((photo) => photo.id))]
    .sort((a, b) => a - b)
    .join(",");
  const photoIds = useMemo(
    () => (photoIdsKey ? photoIdsKey.split(",").map(Number) : []),
    [photoIdsKey]
  );
  const sequenceScopeKey = `${storageKey}:${photoIdsKey}`;
  const sequenceRequestKey = `${refreshVersion}:${sequenceScopeKey}`;
  const sequencesLoading =
    photoIds.length > 0 && loadedSequenceScopeKey !== sequenceScopeKey;
  const loadedScopeRef = useRef(loadedSequenceScopeKey);
  loadedScopeRef.current = loadedSequenceScopeKey;
  const [confirmedSequenceScopeKey, setConfirmedSequenceScopeKey] = useState<
    string | null
  >(null);
  const photosById = useMemo(
    () => new Map(photos.map((photo) => [photo.id, photo])),
    [photos]
  );
  const hydratePhoto = useCallback(
    (photo: Photo): Photo => {
      const current = photosById.get(photo.id);
      return current
        ? {
            ...photo,
            ...current,
            isFavorite: current.isFavorite ?? photo.isFavorite,
          }
        : photo;
    },
    [photosById]
  );
  const visibleSequences = useMemo(() => {
    if (loadedSequenceScopeKey !== sequenceScopeKey) {
      return EMPTY_SEQUENCES;
    }
    return sequences.map((sequence) => ({
      ...sequence,
      photo: hydratePhoto(sequence.photo),
      matchedPhoto: sequence.matchedPhoto
        ? hydratePhoto(sequence.matchedPhoto)
        : undefined,
    }));
  }, [sequences, hydratePhoto, loadedSequenceScopeKey, sequenceScopeKey]);
  const hydrateDetail = useCallback(
    (detail: PhotoSequenceDetail | null) =>
      detail
        ? {
            ...detail,
            members: detail.members.map(hydratePhoto),
          }
        : null,
    [hydratePhoto]
  );
  const visibleDetails = useMemo(
    () => ({
      expandedSequence: hydrateDetail(expandedSequence),
      expandedSequenceComplete: hydrateDetail(expandedSequenceComplete),
      selectedSequence: hydrateDetail(selectedSequence),
      openSequence: hydrateDetail(openSequence),
    }),
    [
      hydrateDetail,
      expandedSequence,
      expandedSequenceComplete,
      selectedSequence,
      openSequence,
    ]
  );

  useSequenceDetailRefresh(
    refreshVersion,
    selectedSequence,
    setSelectedSequence,
    photoIds
  );
  useSequenceDetailRefresh(
    refreshVersion,
    openSequence,
    setOpenSequence,
    photoIds
  );
  useSequenceDetailRefresh(
    refreshVersion,
    expandedSequence,
    setExpandedSequence,
    photoIds
  );
  useSequenceDetailRefresh(
    refreshVersion,
    expandedSequenceComplete,
    setExpandedSequenceComplete
  );
  const revisionRef = useRef(0);
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.data?.channel === "sequences-changed") {
        if (typeof event.data.revision === "number") {
          if (event.data.revision <= revisionRef.current) {
            return;
          }
          revisionRef.current = event.data.revision;
        }
        requestRef.current += 1;
        detailsRequestRef.current += 1;
        setExpandingSequenceId(null);
        if (
          event.data.reason === "reorder" &&
          typeof event.data.sequenceId === "number" &&
          Array.isArray(event.data.orderedMemberIds)
        ) {
          updateSequenceOrder({
            orderedMemberIds: event.data.orderedMemberIds,
            sequenceId: event.data.sequenceId,
          });
        }
        detailCacheRef.current.clear();
        setRefreshVersion((value) => value + 1);
      }
    };
    const onFocus = () => {
      requestRef.current += 1;
      detailsRequestRef.current += 1;
      detailCacheRef.current.clear();
      setRefreshVersion((value) => value + 1);
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      window.removeEventListener("focus", onFocus);
    };
  }, [updateSequenceOrder]);

  useEffect(() => {
    const requestedVersion = refreshVersion;
    let cancelled = false;
    const preserveExistingSequences =
      loadedScopeRef.current === sequenceScopeKey;
    if (!preserveExistingSequences) {
      setSequences([]);
      requestRef.current += 1;
      detailsRequestRef.current += 1;
      detailCacheRef.current.clear();
      setExpandedSequence(null);
      setExpandedSequenceComplete(null);
      setSelectedSequence(null);
      setOpenSequence(null);
    }
    setSequencesError(false);
    if (photoIds.length === 0) {
      setSequences([]);
      setConfirmedSequenceScopeKey(sequenceScopeKey);
      setLoadedSequenceScopeKey(sequenceScopeKey);
      setLoadedSequenceRequestKey(sequenceRequestKey);
      return;
    }
    photoSequenceActions
      .list({ photoIds, scope: "members" })
      .then((result) => {
        if (!cancelled && requestedVersion === refreshVersion) {
          setSequences(result as PhotoSequence[]);
          setConfirmedSequenceScopeKey(sequenceScopeKey);
          setLoadedSequenceScopeKey(sequenceScopeKey);
          setLoadedSequenceRequestKey(sequenceRequestKey);
        }
      })
      .catch((error) => {
        console.error("[useCollectionSequences] list failed", error);
        if (!cancelled) {
          if (!preserveExistingSequences) {
            setSequences([]);
          }
          setSequencesError(true);
          setLoadedSequenceScopeKey(sequenceScopeKey);
          setLoadedSequenceRequestKey(sequenceRequestKey);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [photoIds, refreshVersion, sequenceRequestKey, sequenceScopeKey]);

  const loadDetail = useCallback(async (sequenceId: number) => {
    const cached = detailCacheRef.current.get(sequenceId);
    if (cached) {
      return cached;
    }
    const cacheGeneration = requestRef.current;
    const result = await photoSequenceActions.get(sequenceId);
    if (!result) {
      throw new Error("Sequence not found");
    }
    const detail = result as unknown as PhotoSequenceDetail;
    if (cacheGeneration === requestRef.current) {
      detailCacheRef.current.set(sequenceId, detail);
    }
    return detail;
  }, []);

  const findScopeIds = useCallback(
    (sequenceId: number) => {
      const sequence = sequences.find((item) => item.id === sequenceId);
      return sequence ? scopedIds(sequence) : EMPTY_IDS;
    },
    [sequences]
  );

  const setMode = useCallback(
    (next: CollectionSequenceMode) => {
      if (next === mode) {
        return;
      }
      setModeState(next);
      try {
        localStorage.setItem(storageKey, next);
      } catch {
        // Keep the in-memory preference.
      }
      onClearSelection();
      requestRef.current += 1;
      setExpandedSequence(null);
      setExpandedSequenceComplete(null);
      setExpandingSequenceId(null);
      setSelectedSequence(null);
      detailsRequestRef.current += 1;
      setOpenSequence(null);
    },
    [mode, onClearSelection, storageKey]
  );

  const openPlayback = useCallback(
    async (sequenceId: number) => {
      const requestId = ++detailsRequestRef.current;
      setSelectedSequence(null);
      setOpenSequence(null);
      try {
        const detail = await loadDetail(sequenceId);
        if (requestId === detailsRequestRef.current) {
          setOpenSequence(scopeDetail(detail, findScopeIds(sequenceId)));
        }
      } catch {
        if (requestId === detailsRequestRef.current) {
          toast.error("无法打开序列");
        }
      }
    },
    [findScopeIds, loadDetail]
  );

  const openDetails = useCallback(
    async (sequenceId: number) => {
      const requestId = ++detailsRequestRef.current;
      try {
        const detail = await loadDetail(sequenceId);
        if (requestId === detailsRequestRef.current) {
          setSelectedSequence(scopeDetail(detail, findScopeIds(sequenceId)));
        }
      } catch {
        if (requestId === detailsRequestRef.current) {
          toast.error("无法打开序列详情");
        }
      }
    },
    [findScopeIds, loadDetail]
  );

  const toggleExpand = useCallback(
    async (sequenceId: number) => {
      const memberIds = findScopeIds(sequenceId);
      onRemoveSelection(memberIds);
      if (expandedSequence?.id === sequenceId) {
        requestRef.current += 1;
        setExpandedSequence(null);
        setExpandedSequenceComplete(null);
        setExpandingSequenceId(null);
        return;
      }
      const requestId = ++requestRef.current;
      setExpandedSequenceComplete(null);
      setExpandingSequenceId(sequenceId);
      try {
        const detail = await loadDetail(sequenceId);
        if (requestId !== requestRef.current) {
          return;
        }
        setExpandedSequenceComplete(detail);
        setExpandedSequence(scopeDetail(detail, memberIds));
      } catch {
        if (requestId === requestRef.current) {
          toast.error("无法展开序列");
        }
      } finally {
        if (requestId === requestRef.current) {
          setExpandingSequenceId(null);
        }
      }
    },
    [expandedSequence?.id, findScopeIds, loadDetail, onRemoveSelection]
  );

  const refreshSequences = useCallback(() => {
    requestRef.current += 1;
    detailsRequestRef.current += 1;
    detailCacheRef.current.clear();
    setExpandedSequence(null);
    setExpandedSequenceComplete(null);
    setExpandingSequenceId(null);
    setSelectedSequence(null);
    setRefreshVersion((value) => value + 1);
  }, []);

  const updateMemberFavorite = useCallback(
    (id: number, isFavorite: boolean) => {
      setExpandedSequence((prev) => {
        if (!prev) {
          return prev;
        }
        return {
          ...prev,
          members: prev.members.map((m) =>
            m.id === id ? { ...m, isFavorite } : m
          ),
        };
      });
      setExpandedSequenceComplete((prev) => {
        if (!prev) {
          return prev;
        }
        return {
          ...prev,
          members: prev.members.map((m) =>
            m.id === id ? { ...m, isFavorite } : m
          ),
        };
      });
    },
    []
  );

  return {
    ...visibleDetails,
    expandingSequenceId,
    mode,
    openDetails,
    openPlayback,
    refreshSequences,
    sequencesLoading,
    sequencesError,
    sequences: visibleSequences,
    sequencesRefreshing: loadedSequenceRequestKey !== sequenceRequestKey,
    sequencesConfirmed: confirmedSequenceScopeKey === sequenceScopeKey,
    setMode,
    setOpenSequence,
    setSelectedSequence,
    toggleExpand,
    updateSequenceOrder,
    updateMemberFavorite,
  };
}
