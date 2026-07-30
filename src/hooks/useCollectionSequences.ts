// biome-ignore-all lint/style/useFilenamingConvention: hooks follow the repository's existing useXxx filename convention.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { INLINE_SEQUENCE_MAX_FRAMES } from "@/components/PhotoGrid";
import { ipc } from "@/ipc/manager";
import type { Photo } from "@/types/photo";
import type {
  PhotoSequence,
  PhotoSequenceDetail,
} from "@/types/photo-sequence";

export type CollectionSequenceMode = "all" | "collapsed";

const EMPTY_IDS: number[] = [];

function readMode(storageKey: string): CollectionSequenceMode {
  try {
    return localStorage.getItem(storageKey) === "all" ? "all" : "collapsed";
  } catch {
    return "collapsed";
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
    endedAt: members.at(-1)?.fileDate ?? detail.endedAt,
    frameCount: members.length,
    members,
    representativePhotoId,
    startedAt: members[0]?.fileDate ?? detail.startedAt,
  };
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
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [expandedSequence, setExpandedSequence] =
    useState<PhotoSequenceDetail | null>(null);
  const [expandingSequenceId, setExpandingSequenceId] = useState<number | null>(
    null
  );
  const [selectedSequence, setSelectedSequence] =
    useState<PhotoSequenceDetail | null>(null);
  const [openSequence, setOpenSequence] = useState<PhotoSequenceDetail | null>(
    null
  );
  const [workspaceSequence, setWorkspaceSequence] =
    useState<PhotoSequenceDetail | null>(null);
  const [workspaceScopeIds, setWorkspaceScopeIds] =
    useState<number[]>(EMPTY_IDS);
  const requestRef = useRef(0);
  const detailCacheRef = useRef(new Map<number, PhotoSequenceDetail>());

  const photoIds = useMemo(() => photos.map((photo) => photo.id), [photos]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.data?.channel === "sequences-changed") {
        detailCacheRef.current.clear();
        setRefreshVersion((value) => value + 1);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    const requestedVersion = refreshVersion;
    let cancelled = false;
    if (photoIds.length === 0) {
      setSequences([]);
      return;
    }
    ipc.client.photos
      .listSequences({ photoIds, scope: "members" })
      .then((result) => {
        if (!cancelled && requestedVersion === refreshVersion) {
          setSequences(result as PhotoSequence[]);
        }
      })
      .catch((error) => {
        console.error("[useCollectionSequences] list failed", error);
        if (!cancelled) {
          setSequences([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [photoIds, refreshVersion]);

  const loadDetail = useCallback(async (sequenceId: number) => {
    const cached = detailCacheRef.current.get(sequenceId);
    if (cached) {
      return cached;
    }
    const result = await ipc.client.photos.getSequence({ id: sequenceId });
    if (!result) {
      throw new Error("Sequence not found");
    }
    const detail = result as unknown as PhotoSequenceDetail;
    detailCacheRef.current.set(sequenceId, detail);
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
      setExpandingSequenceId(null);
      setSelectedSequence(null);
      setOpenSequence(null);
      setWorkspaceSequence(null);
      setWorkspaceScopeIds(EMPTY_IDS);
    },
    [mode, onClearSelection, storageKey]
  );

  const openPlayback = useCallback(
    async (sequenceId: number) => {
      try {
        const detail = await loadDetail(sequenceId);
        setOpenSequence(scopeDetail(detail, findScopeIds(sequenceId)));
      } catch {
        toast.error("无法打开序列");
      }
    },
    [findScopeIds, loadDetail]
  );

  const openDetails = useCallback(
    async (sequenceId: number) => {
      try {
        const detail = await loadDetail(sequenceId);
        setSelectedSequence(scopeDetail(detail, findScopeIds(sequenceId)));
      } catch {
        toast.error("无法打开序列详情");
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
        setExpandingSequenceId(null);
        return;
      }
      const requestId = ++requestRef.current;
      setExpandingSequenceId(sequenceId);
      try {
        const detail = await loadDetail(sequenceId);
        if (requestId !== requestRef.current) {
          return;
        }
        if (memberIds.length > INLINE_SEQUENCE_MAX_FRAMES) {
          setWorkspaceScopeIds(memberIds);
          setWorkspaceSequence(detail);
          setExpandedSequence(null);
        } else {
          setExpandedSequence(scopeDetail(detail, memberIds));
        }
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

  const closeWorkspace = useCallback(() => {
    setWorkspaceSequence(null);
    setWorkspaceScopeIds(EMPTY_IDS);
  }, []);

  const manageSequence = useCallback(
    async (sequenceId: number) => {
      const memberIds = findScopeIds(sequenceId);
      onRemoveSelection(memberIds);
      try {
        const detail = await loadDetail(sequenceId);
        setWorkspaceScopeIds(memberIds);
        setWorkspaceSequence(detail);
        setSelectedSequence(null);
        setExpandedSequence(null);
      } catch {
        toast.error("无法打开序列管理");
      }
    },
    [findScopeIds, loadDetail, onRemoveSelection]
  );

  return {
    closeWorkspace,
    expandedSequence,
    expandingSequenceId,
    manageSequence,
    mode,
    openDetails,
    openPlayback,
    openSequence,
    selectedSequence,
    sequences,
    setMode,
    setOpenSequence,
    setSelectedSequence,
    toggleExpand,
    workspaceScopeIds,
    workspaceSequence,
  };
}
