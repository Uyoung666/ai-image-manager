import { useEffect, useState } from "react";
import {
  CULL_WRITE_STATE,
  type CullWriteState,
} from "@/utils/cull-write-state";

export function useCullSaveStatus(scopeIds: Array<number | string | null>) {
  const [status, setStatus] = useState<CullWriteState["state"]>("saved");
  const key = [...new Set(scopeIds.filter((id) => id !== null))].join(",");
  useEffect(() => {
    let pending = 0;
    let failed = false;
    setStatus("saved");
    const changed = (event: Event) => {
      const detail = (event as CustomEvent<CullWriteState>).detail;
      if (!key.split(",").includes(String(detail.scopeId))) {
        return;
      }
      if (detail.state === "saving") {
        if (pending === 0) {
          failed = false;
        }
        pending++;
      } else {
        pending = Math.max(0, pending - 1);
        failed ||= detail.state === "error";
      }
      let next: CullWriteState["state"] = "saved";
      if (pending > 0) {
        next = "saving";
      }
      if (failed) {
        next = "error";
      }
      setStatus(next);
    };
    window.addEventListener(CULL_WRITE_STATE, changed);
    return () => window.removeEventListener(CULL_WRITE_STATE, changed);
  }, [key]);
  return status;
}
