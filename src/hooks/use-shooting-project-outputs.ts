import { useCallback, useEffect, useRef, useState } from "react";
import { shootingProjectActions } from "@/actions/shooting-projects";
import { shootingProjectErrorKey } from "@/components/ShootingProjectStatus";
import type { ShootingProjectOutputTask } from "@/types/shooting-project";

const ACTIVE_OUTPUT_STATUSES = new Set(["pending", "running"]);

export function useShootingProjectOutputs(projectId: string, enabled = true) {
  const [tasks, setTasks] = useState<ShootingProjectOutputTask[]>([]);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [busyTask, setBusyTask] = useState<string | null>(null);
  const [watchRetry, setWatchRetry] =
    useState<ShootingProjectOutputTask | null>(null);
  const active = useRef(false);
  const watchedCompletion = useRef(new Set<string>());
  const generation = useRef(0);

  const openOutput = useCallback(
    async (taskId: string) => {
      try {
        const result = await shootingProjectActions.openOutput({
          projectId,
          taskId,
        });
        if (!result.opened && active.current) {
          setErrorKey("shootingProject.outputOpenFailed");
        }
      } catch (error) {
        if (active.current) {
          setErrorKey(shootingProjectErrorKey(error));
        }
      }
    },
    [projectId]
  );

  const acceptTasks = useCallback(
    (next: ShootingProjectOutputTask[]) => {
      if (!active.current) {
        return;
      }
      setTasks(next);
      for (const task of next) {
        if (
          task.status === "completed" &&
          watchedCompletion.current.delete(task.id)
        ) {
          openOutput(task.id);
        }
      }
    },
    [openOutput]
  );

  const load = useCallback(async () => {
    const version = generation.current;
    try {
      const next = await shootingProjectActions.listOutputs(projectId);
      if (version === generation.current) {
        acceptTasks(next);
      }
    } catch (error) {
      if (active.current) {
        setErrorKey(shootingProjectErrorKey(error));
      }
    }
  }, [acceptTasks, projectId]);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    active.current = true;
    load();
    return () => {
      active.current = false;
      generation.current += 1;
    };
  }, [load, enabled]);
  const preparing = tasks.some((task) =>
    ACTIVE_OUTPUT_STATUSES.has(task.status)
  );
  useEffect(() => {
    if (!(enabled && preparing)) {
      return;
    }
    const timer = setInterval(load, 1000);
    return () => clearInterval(timer);
  }, [load, preparing, enabled]);

  function updateTask(task: ShootingProjectOutputTask, watch = false) {
    generation.current += 1;
    if (watch) {
      watchedCompletion.current.add(task.id);
    }
    if (
      task.status === "completed" &&
      watchedCompletion.current.delete(task.id)
    ) {
      openOutput(task.id);
    }
    setTasks((previous) => [
      task,
      ...previous.filter((item) => item.id !== task.id),
    ]);
  }
  async function retry(task: ShootingProjectOutputTask, acknowledged = false) {
    setBusyTask(task.id);
    setErrorKey(null);
    try {
      const next = await shootingProjectActions.retryOutput({
        projectId,
        taskId: task.id,
        acknowledgeWatchedTarget: acknowledged,
      });
      updateTask(next, true);
      setWatchRetry(null);
    } catch (error) {
      const key = shootingProjectErrorKey(error);
      if (key === "shootingProject.outputWatchRequired") {
        setWatchRetry(task);
      } else {
        setErrorKey(key);
      }
    } finally {
      setBusyTask(null);
    }
  }
  async function cancel(task: ShootingProjectOutputTask) {
    setBusyTask(task.id);
    setErrorKey(null);
    try {
      updateTask(
        await shootingProjectActions.cancelOutput({
          projectId,
          taskId: task.id,
        })
      );
    } catch (error) {
      setErrorKey(shootingProjectErrorKey(error));
    } finally {
      setBusyTask(null);
    }
  }
  return {
    tasks,
    errorKey,
    setErrorKey,
    busyTask,
    watchRetry,
    setWatchRetry,
    load,
    updateTask,
    retry,
    cancel,
    openOutput,
  };
}
