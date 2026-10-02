import { type Dispatch, type SetStateAction, useEffect, useRef } from "react";
import { photoSequenceActions } from "@/actions/photo-sequences";
import type { PhotoSequenceDetail } from "@/types/photo-sequence";

function scopeDetail(
  result: PhotoSequenceDetail | null,
  scopeIds?: number[]
): PhotoSequenceDetail | null {
  if (!result || result.members.length < 2) {
    return null;
  }
  if (!scopeIds) {
    return result;
  }
  const ids = new Set(scopeIds);
  const members = result.members.filter((member) => ids.has(member.id));
  if (!members.length) {
    return null;
  }
  return {
    ...result,
    members,
    frameCount: members.length,
    representativePhotoId: members.some(
      (member) => member.id === result.representativePhotoId
    )
      ? result.representativePhotoId
      : members[0].id,
  };
}

/** Refresh an open view without allowing an older request to reopen it. */
export function useSequenceDetailRefresh(
  version: number,
  detail: PhotoSequenceDetail | null,
  setDetail: Dispatch<SetStateAction<PhotoSequenceDetail | null>>,
  scopeIds?: number[]
) {
  const current = useRef({ detail, scopeIds });
  current.current = { detail, scopeIds };
  const id = detail?.id;
  const scopeKey = scopeIds?.join(",");
  const last = useRef({ version, id: detail?.id, scopeKey });
  useEffect(() => {
    const snapshot = current.current;
    const previous = last.current;
    last.current = { version, id: snapshot.detail?.id, scopeKey };
    if (id == null || !snapshot.detail || previous.id !== id) {
      return;
    }
    if (previous.version === version && previous.scopeKey === scopeKey) {
      return;
    }
    let cancelled = false;
    photoSequenceActions
      .get(id)
      .then((result) => {
        if (cancelled) {
          return;
        }
        const next = scopeDetail(
          result as PhotoSequenceDetail | null,
          snapshot.scopeIds
        );
        setDetail((existing) => (existing?.id === id ? next : existing));
      })
      .catch(() => {
        // A failed refresh cannot leave stale, actionable sequence controls open.
        if (!cancelled) {
          setDetail((existing) => (existing?.id === id ? null : existing));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [version, id, scopeKey, setDetail]);
}
