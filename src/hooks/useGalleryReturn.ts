import { useCallback, useEffect, useRef, useState } from "react";
import type {
  PhotoSequence,
  PhotoSequenceDetail,
} from "@/types/photo-sequence";
import {
  type GalleryReturnTarget,
  resolveGalleryReturnTarget,
} from "@/utils/gallery-return";

export function useGalleryReturn({
  contextKey,
  photos,
  sequences,
  details,
  ready,
}: {
  contextKey: string;
  photos: readonly { id: number }[];
  sequences: readonly PhotoSequence[];
  details: readonly (PhotoSequenceDetail | null | undefined)[];
  ready: boolean;
}) {
  const [target, setTarget] = useState<GalleryReturnTarget | null>(null);
  const [request, setRequest] = useState(0);
  const [pending, setPending] = useState(false);
  const [pulseActive, setPulseActive] = useState(false);
  const requestRef = useRef(0);
  const pendingRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const browsingTargetRef = useRef<GalleryReturnTarget | null>(null);
  const previousContextRef = useRef(contextKey);
  const dataRef = useRef({ photos, sequences, details });
  dataRef.current = { photos, sequences, details };

  const stopPulse = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setPulseActive(false);
  }, []);
  const cancelReturn = useCallback(() => {
    pendingRef.current = false;
    setPending(false);
    stopPulse();
  }, [stopPulse]);
  const clearRecentlyViewed = useCallback(
    (preservePhotoId?: number) => {
      setTarget((current) =>
        current && "photoId" in current && current.photoId === preservePhotoId
          ? current
          : null
      );
      cancelReturn();
    },
    [cancelReturn]
  );
  const rememberPhoto = useCallback((photoId: number, sequenceId?: number) => {
    const data = dataRef.current;
    const sequence = data.sequences.find((item) =>
      (item.memberPhotoIds ?? item.matchedPhotoIds ?? []).includes(photoId)
    );
    const detail = data.details.find((item) =>
      item?.members.some((photo) => photo.id === photoId)
    );
    const ownerId = sequenceId ?? sequence?.id ?? detail?.id;
    const next: GalleryReturnTarget =
      ownerId === undefined
        ? { kind: "photo", photoId }
        : { kind: "sequence-member", sequenceId: ownerId, photoId };
    browsingTargetRef.current = next;
    return next;
  }, []);
  const beginSequence = useCallback(
    (sequenceId: number) => {
      clearRecentlyViewed();
      browsingTargetRef.current = { kind: "sequence", sequenceId };
    },
    [clearRecentlyViewed]
  );
  const markTarget = useCallback(
    (next: GalleryReturnTarget) => {
      stopPulse();
      setTarget(next);
      requestRef.current += 1;
      setRequest(requestRef.current);
      pendingRef.current = true;
      setPending(true);
    },
    [stopPulse]
  );
  const markRecentlyViewed = useCallback(
    (photoId: number, sequenceId?: number) => {
      markTarget(rememberPhoto(photoId, sequenceId));
    },
    [markTarget, rememberPhoto]
  );
  const markSequence = useCallback(
    (sequenceId: number) => {
      const remembered = browsingTargetRef.current;
      markTarget(
        remembered &&
          "sequenceId" in remembered &&
          remembered.sequenceId === sequenceId
          ? remembered
          : { kind: "sequence", sequenceId }
      );
    },
    [markTarget]
  );
  const settleReturn = useCallback((completedRequest: number) => {
    if (!pendingRef.current || completedRequest !== requestRef.current) {
      return;
    }
    pendingRef.current = false;
    setPending(false);
    setPulseActive(true);
    timerRef.current = setTimeout(() => {
      setPulseActive(false);
      timerRef.current = null;
    }, 1500);
  }, []);

  useEffect(() => {
    if (previousContextRef.current !== contextKey) {
      clearRecentlyViewed();
      browsingTargetRef.current = null;
      previousContextRef.current = contextKey;
    }
  }, [contextKey, clearRecentlyViewed]);
  useEffect(() => {
    if (!ready) {
      return;
    }
    const resolved = resolveGalleryReturnTarget(
      target,
      photos,
      sequences,
      details.filter((detail): detail is PhotoSequenceDetail => Boolean(detail))
    );
    if (resolved !== target) {
      setTarget(resolved);
      if (!resolved) {
        cancelReturn();
      }
    }
  }, [target, photos, sequences, details, ready, cancelReturn]);
  useEffect(() => {
    if (!pending) {
      return;
    }
    const cancel = () => cancelReturn();
    window.addEventListener("wheel", cancel, { capture: true, passive: true });
    window.addEventListener("pointerdown", cancel, true);
    window.addEventListener("keydown", cancel, true);
    return () => {
      window.removeEventListener("wheel", cancel, true);
      window.removeEventListener("pointerdown", cancel, true);
      window.removeEventListener("keydown", cancel, true);
    };
  }, [pending, cancelReturn]);
  useEffect(
    () => () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
      }
    },
    []
  );

  return {
    recentlyViewedTarget: target,
    recentlyViewedPhotoId:
      target && "photoId" in target ? target.photoId : null,
    recentlyViewedPulseActive: pulseActive,
    recentlyViewedPulseKey: request,
    recentlyViewedReturnRequest: pending ? request : 0,
    beginSequence,
    rememberPhoto,
    markSequence,
    markRecentlyViewed,
    clearRecentlyViewed,
    settleReturn,
    cancelReturn,
    stopPulse,
  };
}
