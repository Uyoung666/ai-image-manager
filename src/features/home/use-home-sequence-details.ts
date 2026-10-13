// biome-ignore-all lint/style/noNestedTernary: preserve scoped sequence detail presentation

import type { Dispatch, SetStateAction } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { photoSequenceActions } from "@/actions/photo-sequences";
import { useSequenceDetailRefresh } from "@/hooks/useSequenceDetailRefresh";
import type {
  PhotoSequence,
  PhotoSequenceDetail,
  SequenceOrderChange,
} from "@/types/photo-sequence";

interface Options {
  isSearching: boolean;
  sequenceRefresh: number;
  sequences: PhotoSequence[];
  setSequences: Dispatch<SetStateAction<PhotoSequence[]>>;
}
export function useHomeSequenceDetails({
  isSearching,
  sequenceRefresh,
  sequences,
  setSequences,
}: Options) {
  const { t } = useTranslation();

  const [openSequence, setOpenSequence] = useState<PhotoSequenceDetail | null>(
    null
  );

  const [sequenceAutoPlay, setSequenceAutoPlay] = useState(false);

  const [expandedSequence, setExpandedSequence] =
    useState<PhotoSequenceDetail | null>(null);

  const [expandedSequenceComplete, setExpandedSequenceComplete] =
    useState<PhotoSequenceDetail | null>(null);

  const [expandingSequenceId, setExpandingSequenceId] = useState<number | null>(
    null
  );

  const expandedSequenceCacheRef = useRef<Map<number, PhotoSequenceDetail>>(
    new Map()
  );

  const expandSequenceRequestRef = useRef(0);

  const sequenceDetailsRequestRef = useRef(0);

  const [selectedSequence, setSelectedSequence] =
    useState<PhotoSequenceDetail | null>(null);

  const [sequenceReturnTarget, setSequenceReturnTarget] =
    useState<PhotoSequenceDetail | null>(null);

  const [sequenceDetailsLoading, setSequenceDetailsLoading] = useState(false);

  const handleSequenceOrderChange = useCallback(
    ({ orderedMemberIds, sequenceId }: SequenceOrderChange) => {
      const reorderMembers = <T extends { id: number }>(members: T[]) => {
        const membersById = new Map(
          members.map((member) => [member.id, member])
        );
        const seen = new Set<number>();
        const ordered = orderedMemberIds.flatMap((id) => {
          const member = membersById.get(id);
          if (!member || seen.has(id)) {
            return [];
          }
          seen.add(id);
          return [member];
        });
        return ordered.concat(members.filter((member) => !seen.has(member.id)));
      };
      const applyOrder = (detail: PhotoSequenceDetail) => ({
        ...detail,
        members: reorderMembers(detail.members),
      });
      setExpandedSequence((current) =>
        current?.id === sequenceId ? applyOrder(current) : current
      );
      setExpandedSequenceComplete((current) =>
        current?.id === sequenceId ? applyOrder(current) : current
      );
      const cached = expandedSequenceCacheRef.current.get(sequenceId);
      if (cached) {
        expandedSequenceCacheRef.current.set(sequenceId, applyOrder(cached));
      }
      setSequences((current) =>
        current.map((sequence) => {
          if (sequence.id !== sequenceId) {
            return sequence;
          }
          const next = { ...sequence };
          if (sequence.memberPhotoIds) {
            const memberIds = new Set(sequence.memberPhotoIds);
            next.memberPhotoIds = orderedMemberIds.filter((id) =>
              memberIds.has(id)
            );
          }
          if (sequence.matchedPhotoIds) {
            const matchedIds = new Set(sequence.matchedPhotoIds);
            next.matchedPhotoIds = orderedMemberIds.filter((id) =>
              matchedIds.has(id)
            );
            next.matchedCount = next.matchedPhotoIds.length;
          }
          return next;
        })
      );
    },
    [setSequences]
  );

  useSequenceDetailRefresh(
    sequenceRefresh,
    selectedSequence,
    setSelectedSequence
  );

  useSequenceDetailRefresh(
    sequenceRefresh,
    openSequence,
    setOpenSequence,
    isSearching
      ? (sequences.find((entry) => entry.id === openSequence?.id)
          ?.matchedPhotoIds ?? [])
      : undefined
  );

  useSequenceDetailRefresh(
    sequenceRefresh,
    expandedSequence,
    setExpandedSequence,
    sequences.find((entry) => entry.id === expandedSequence?.id)
      ?.matchedPhotoIds ?? []
  );

  useSequenceDetailRefresh(
    sequenceRefresh,
    expandedSequenceComplete,
    setExpandedSequenceComplete
  );

  const handleOpenSequence = useCallback(
    (sequenceId: number) => {
      const requestId = ++sequenceDetailsRequestRef.current;
      setSelectedSequence(null);
      setSequenceDetailsLoading(false);
      const sequenceSummary = sequences.find(
        (sequence) => sequence.id === sequenceId
      );
      const scopeIds =
        sequenceSummary?.matchedPhotoIds ??
        sequenceSummary?.memberPhotoIds ??
        [];
      const scopeIdSet = new Set(scopeIds);
      photoSequenceActions
        .get(sequenceId)
        .then((sequence) => {
          if (sequence && requestId === sequenceDetailsRequestRef.current) {
            setSequenceAutoPlay(false);
            const detail = sequence as unknown as PhotoSequenceDetail;
            const members = detail.members.filter((photo) =>
              scopeIdSet.has(photo.id)
            );
            setOpenSequence({
              ...detail,
              frameCount: members.length,
              members,
              representativePhotoId: scopeIdSet.has(
                detail.representativePhotoId ?? -1
              )
                ? detail.representativePhotoId
                : (members[0]?.id ?? null),
            });
          }
        })
        .catch(() => {
          if (requestId === sequenceDetailsRequestRef.current) {
            toast.error(t("sequenceOpenFailed"));
          }
        });
    },
    [sequences, t]
  );

  const handleOpenSequenceDetails = useCallback(
    (sequenceId: number) => {
      const requestId = ++sequenceDetailsRequestRef.current;
      setSequenceDetailsLoading(true);
      photoSequenceActions
        .get(sequenceId)
        .then((sequence) => {
          if (sequence && requestId === sequenceDetailsRequestRef.current) {
            setSelectedSequence(sequence as unknown as PhotoSequenceDetail);
          }
        })
        .catch(() => {
          if (requestId === sequenceDetailsRequestRef.current) {
            toast.error(t("sequenceDetailOpenFailed"));
          }
        })
        .finally(() => {
          if (requestId === sequenceDetailsRequestRef.current) {
            setSequenceDetailsLoading(false);
          }
        });
    },
    [t]
  );

  const handleToggleSequenceExpand = useCallback(
    (sequenceId: number) => {
      if (expandedSequence?.id === sequenceId) {
        expandSequenceRequestRef.current += 1;
        setExpandedSequence(null);
        setExpandedSequenceComplete(null);
        setExpandingSequenceId(null);
        return;
      }

      const requestId = ++expandSequenceRequestRef.current;
      const sequenceSummary = sequences.find(
        (sequence) => sequence.id === sequenceId
      );
      const memberIds =
        sequenceSummary?.matchedPhotoIds ??
        sequenceSummary?.memberPhotoIds ??
        [];
      const cached = expandedSequenceCacheRef.current.get(sequenceId);
      if (cached) {
        setExpandedSequenceComplete(cached);
        const scopedMemberIds = new Set(memberIds);
        const members = cached.members.filter((photo) =>
          scopedMemberIds.has(photo.id)
        );
        setExpandedSequence({
          ...cached,
          frameCount: members.length,
          members,
          representativePhotoId: scopedMemberIds.has(
            cached.representativePhotoId ?? -1
          )
            ? cached.representativePhotoId
            : (members[0]?.id ?? null),
        });
        setExpandingSequenceId(null);
        return;
      }

      setExpandingSequenceId(sequenceId);
      setExpandedSequenceComplete(null);
      photoSequenceActions
        .get(sequenceId)
        .then((sequence) => {
          if (!sequence || requestId !== expandSequenceRequestRef.current) {
            return;
          }
          const detail = sequence as unknown as PhotoSequenceDetail;
          expandedSequenceCacheRef.current.set(sequenceId, detail);
          setExpandedSequenceComplete(detail);
          const scopedMemberIds = new Set(memberIds);
          const members = detail.members.filter((photo) =>
            scopedMemberIds.has(photo.id)
          );
          setExpandedSequence({
            ...detail,
            frameCount: members.length,
            members,
            representativePhotoId: scopedMemberIds.has(
              detail.representativePhotoId ?? -1
            )
              ? detail.representativePhotoId
              : (members[0]?.id ?? null),
          });
        })
        .catch(() => {
          if (requestId === expandSequenceRequestRef.current) {
            toast.error(t("sequenceOpenFailed"));
          }
        })
        .finally(() => {
          if (requestId === expandSequenceRequestRef.current) {
            setExpandingSequenceId(null);
          }
        });
    },
    [expandedSequence?.id, sequences, t]
  );

  useEffect(() => {
    expandSequenceRequestRef.current += 1;
    setExpandedSequence(null);
    setExpandedSequenceComplete(null);
    setExpandingSequenceId(null);
    expandedSequenceCacheRef.current.clear();
  }, []);
  return {
    openSequence,
    setOpenSequence,
    sequenceAutoPlay,
    setSequenceAutoPlay,
    expandedSequence,
    setExpandedSequence,
    expandedSequenceComplete,
    setExpandedSequenceComplete,
    expandingSequenceId,
    setExpandingSequenceId,
    expandedSequenceCacheRef,
    expandSequenceRequestRef,
    sequenceDetailsRequestRef,
    selectedSequence,
    setSelectedSequence,
    sequenceReturnTarget,
    setSequenceReturnTarget,
    sequenceDetailsLoading,
    setSequenceDetailsLoading,
    handleSequenceOrderChange,
    handleOpenSequence,
    handleOpenSequenceDetails,
    handleToggleSequenceExpand,
  };
}
