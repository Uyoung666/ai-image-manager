import { useCallback, useRef, useState } from "react";

export interface SequenceClickFocusRequest {
  id: number;
  memberId: number | null;
  sequenceId: number;
}

export function useSequenceClickFocusRequest() {
  const requestIdRef = useRef(0);
  const [sequenceFocusRequest, setSequenceFocusRequest] =
    useState<SequenceClickFocusRequest | null>(null);
  const clearSequenceFocus = useCallback(() => {
    setSequenceFocusRequest(null);
  }, []);
  const requestSequenceFocus = useCallback(
    (sequenceId: number, memberId: number | null, event?: React.MouseEvent) => {
      if (
        !event ||
        event.type !== "click" ||
        event.detail <= 0 ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        event.altKey
      ) {
        setSequenceFocusRequest(null);
        return;
      }
      requestIdRef.current += 1;
      setSequenceFocusRequest({
        id: requestIdRef.current,
        sequenceId,
        memberId,
      });
    },
    []
  );
  return { sequenceFocusRequest, requestSequenceFocus, clearSequenceFocus };
}
