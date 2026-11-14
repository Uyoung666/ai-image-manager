import { useEffect, useRef, useState } from "react";
import { libraryReliabilityActions } from "@/actions/library-reliability";
import type { LibrarySourceStatus } from "@/types/library-reliability";

type CheckState = "checking" | "done" | "cancelled" | "failed";
type Task = Awaited<ReturnType<typeof libraryReliabilityActions.getTask>>;
function completionState(task: Task): CheckState {
  if (task.status === "cancelled") {
    return "cancelled";
  }
  if (task.status === "done" && task.errors.length === 0) {
    return "done";
  }
  return "failed";
}
export function useLibraryPhotoCheck(photoId: number, onUpdated?: () => void) {
  const [taskId, setTaskId] = useState<string>();
  const [status, setStatus] = useState<CheckState>();
  const [sourceStatus, setSourceStatus] = useState<LibrarySourceStatus>();
  const updated = useRef(onUpdated);
  updated.current = onUpdated;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!taskId) {
      return;
    }
    const id = taskId;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      try {
        const task = await libraryReliabilityActions.getTask(id);
        if (!active) {
          return;
        }
        if (task.status === "queued" || task.status === "running") {
          timer = setTimeout(poll, 800);
          return;
        }
        setTaskId(undefined);
        setStatus(completionState(task));
        setSourceStatus(task.photoStatus?.sourceStatus);
        updated.current?.();
      } catch {
        if (active) {
          setTaskId(undefined);
          setStatus("failed");
        }
      }
    }
    poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [taskId]);
  async function start() {
    setStatus("checking");
    setSourceStatus(undefined);
    try {
      const task = await libraryReliabilityActions.reconcile({
        photoIds: [photoId],
      });
      if (mounted.current) {
        setTaskId(task.taskId);
      }
    } catch {
      if (mounted.current) {
        setStatus("failed");
      }
    }
  }
  return { start, status, sourceStatus, checking: status === "checking" };
}
