import { useCallback, useEffect, useRef, useState } from "react";
import { shootingProjectActions } from "@/actions/shooting-projects";
import { shootingProjectErrorKey } from "@/components/ShootingProjectStatus";
import type {
  ShootingProjectBrowseState,
  ShootingProjectPhoto,
  ShootingProjectPhotoStatus,
  ShootingProjectWorkspaceData,
} from "@/types/shooting-project";

type WorkspaceAction = () =>
  | Promise<ShootingProjectWorkspaceData | undefined>
  | Promise<void>;
interface WorkspaceWrite {
  action: WorkspaceAction;
  isRelevant: () => boolean;
}
const ALWAYS_RELEVANT = () => true;

export function sortShootingProjectPhotos(
  photos: ShootingProjectPhoto[],
  sort: ShootingProjectBrowseState["sort"]
): string[] {
  return [...photos]
    .sort((left, right) => {
      if (sort === "time") {
        const delta =
          (left.dateTaken ?? left.modifiedAt) -
          (right.dateTaken ?? right.modifiedAt);
        if (delta !== 0) {
          return delta;
        }
      }
      if (sort === "format") {
        const delta = left.format.localeCompare(right.format);
        if (delta !== 0) {
          return delta;
        }
      }
      return (
        left.relativePath.localeCompare(right.relativePath, undefined, {
          numeric: true,
        }) || left.id.localeCompare(right.id)
      );
    })
    .map((photo) => photo.id);
}

/** Append discoveries; metadata enrichment never reorders an existing browse sequence. */
export function mergeShootingProjectBrowse(
  state: ShootingProjectBrowseState,
  photos: ShootingProjectPhoto[]
): ShootingProjectBrowseState {
  const known = new Set(photos.map((photo) => photo.id));
  const ordered = [...new Set(state.orderedPhotoIds)].filter((id) =>
    known.has(id)
  );
  const existing = new Set(ordered);
  ordered.push(
    ...sortShootingProjectPhotos(
      photos.filter((photo) => !existing.has(photo.id)),
      state.sort
    )
  );
  const currentPhotoId =
    state.currentPhotoId && known.has(state.currentPhotoId)
      ? state.currentPhotoId
      : (ordered[0] ?? null);
  if (
    currentPhotoId === state.currentPhotoId &&
    ordered.length === state.orderedPhotoIds.length &&
    ordered.every((id, index) => id === state.orderedPhotoIds[index])
  ) {
    return state;
  }
  return { ...state, orderedPhotoIds: ordered, currentPhotoId };
}

export function useShootingProjectWorkspace(
  projectId: string,
  persistBrowseOnExit = true
) {
  const [data, setData] = useState<ShootingProjectWorkspaceData | null>(null);
  const [browsing, setBrowsing] = useState<ShootingProjectBrowseState | null>(
    null
  );
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<"saved" | "saving" | "error">(
    "saved"
  );
  const [loading, setLoading] = useState(true);
  const active = useRef(false);
  const dataRef = useRef<ShootingProjectWorkspaceData | null>(null);
  const persistedBrowse = useRef<string | null>(null);
  const latestBrowse = useRef<ShootingProjectBrowseState | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const pending = useRef(0);
  const failedActions = useRef<WorkspaceWrite[]>([]);
  const selectionRevision = useRef(0);
  const latestSelections = useRef(new Map<string, number>());
  const generation = useRef(0);

  const finishWrite = useCallback(() => {
    pending.current -= 1;
    if (!active.current) {
      return;
    }
    let status: "error" | "saving" | "saved" =
      pending.current > 0 ? "saving" : "saved";
    if (failedActions.current.length > 0) {
      status = "error";
    }
    setSaveStatus(status);
  }, []);

  const completeWrite = useCallback((write: WorkspaceWrite) => {
    failedActions.current = failedActions.current.filter(
      (failed) => failed.action !== write.action && failed.isRelevant()
    );
    if (active.current && failedActions.current.length === 0) {
      setErrorKey(null);
    }
  }, []);

  const failWrite = useCallback((write: WorkspaceWrite, error: unknown) => {
    failedActions.current = failedActions.current.filter((failed) =>
      failed.isRelevant()
    );
    if (
      write.isRelevant() &&
      !failedActions.current.some((failed) => failed.action === write.action)
    ) {
      failedActions.current.push(write);
    }
    if (active.current && failedActions.current.length > 0) {
      setErrorKey(shootingProjectErrorKey(error));
    }
  }, []);

  const accept = useCallback((next: ShootingProjectWorkspaceData) => {
    if (!active.current) {
      return;
    }
    dataRef.current = next;
    persistedBrowse.current ??= JSON.stringify(next.browsing);
    setData(next);
    setBrowsing((previous) => {
      const value = mergeShootingProjectBrowse(
        previous ?? next.browsing,
        next.photos
      );
      latestBrowse.current = value;
      return value;
    });
  }, []);

  const run = useCallback(
    (
      action: WorkspaceAction,
      isRelevant: () => boolean = ALWAYS_RELEVANT
    ): Promise<boolean> => {
      pending.current += 1;
      generation.current += 1;
      if (active.current) {
        setSaveStatus("saving");
      }
      const write = { action, isRelevant };
      const result = queue.current.then(async () => {
        try {
          const next = await action();
          if (next) {
            accept(next);
          }
          completeWrite(write);
          return true;
        } catch (error) {
          failWrite(write, error);
          return false;
        } finally {
          finishWrite();
        }
      });
      queue.current = result;
      return result;
    },
    [accept, completeWrite, failWrite, finishWrite]
  );

  const select = useCallback(
    (photoIds: string[], status: ShootingProjectPhotoStatus) => {
      const ids = [...new Set(photoIds)];
      const revision = ++selectionRevision.current;
      for (const id of ids) {
        latestSelections.current.set(id, revision);
      }
      const relevantIds = () =>
        ids.filter((id) => latestSelections.current.get(id) === revision);
      let attempted = false;
      return run(
        async () => {
          // Keep normal writes in order; retries only apply the intent still current for each photo.
          const currentIds = attempted ? relevantIds() : ids;
          attempted = true;
          if (currentIds.length === 0) {
            return;
          }
          return await shootingProjectActions.select({
            projectId,
            photoIds: currentIds,
            status,
          });
        },
        () => relevantIds().length > 0
      );
    },
    [projectId, run]
  );

  const writeLatestBrowse = useCallback(async () => {
    const next = latestBrowse.current;
    if (!next) {
      return;
    }
    const serialized = JSON.stringify(next);
    if (serialized === persistedBrowse.current) {
      return;
    }
    const result = await shootingProjectActions.saveBrowse({
      projectId,
      browsing: next,
    });
    if (!result.saved) {
      throw new Error("Browse state was not saved");
    }
    persistedBrowse.current = serialized;
  }, [projectId]);

  const browseNeedsSave = useCallback(
    () =>
      Boolean(
        latestBrowse.current &&
          JSON.stringify(latestBrowse.current) !== persistedBrowse.current
      ),
    []
  );

  const persistBrowsing = useCallback(
    (next: ShootingProjectBrowseState) => {
      const serialized = JSON.stringify(next);
      if (serialized === persistedBrowse.current) {
        return;
      }
      run(writeLatestBrowse, browseNeedsSave);
    },
    [run, writeLatestBrowse, browseNeedsSave]
  );

  const refresh = useCallback(
    async (checkSource = false) => {
      const version = ++generation.current;
      try {
        if (checkSource) {
          await shootingProjectActions.open(projectId);
        }
        const result = await shootingProjectActions.workspace(projectId);
        if (
          active.current &&
          generation.current === version &&
          pending.current === 0
        ) {
          accept(result);
          if (failedActions.current.length === 0) {
            setErrorKey(null);
          }
        }
      } catch (error) {
        if (active.current && generation.current === version) {
          setErrorKey(shootingProjectErrorKey(error));
        }
      } finally {
        if (active.current) {
          setLoading(false);
        }
      }
    },
    [accept, projectId]
  );

  useEffect(() => {
    active.current = true;
    dataRef.current = null;
    persistedBrowse.current = null;
    latestBrowse.current = null;
    latestSelections.current.clear();
    selectionRevision.current = 0;
    setData(null);
    setBrowsing(null);
    setLoading(true);
    refresh(true);
    const timer = setInterval(() => {
      const snapshot = dataRef.current;
      if (pending.current || !snapshot) {
        return;
      }
      const preparing =
        snapshot.scan.status === "running" ||
        snapshot.scan.status === "pending" ||
        (snapshot.project.sourceStatus === "online" &&
          snapshot.photos.some((photo) => photo.previewStatus === "pending"));
      if (preparing) {
        refresh();
      }
    }, 1500);
    return () => {
      if (persistBrowseOnExit && latestBrowse.current) {
        persistBrowsing(latestBrowse.current);
      }
      active.current = false;
      generation.current += 1;
      clearInterval(timer);
    };
  }, [refresh, persistBrowsing, persistBrowseOnExit]);

  const updateBrowse = useCallback((next: ShootingProjectBrowseState) => {
    latestBrowse.current = next;
    setBrowsing(next);
  }, []);

  useEffect(() => {
    if (!browsing) {
      return;
    }
    const timer = setTimeout(() => persistBrowsing(browsing), 150);
    return () => clearTimeout(timer);
  }, [browsing, persistBrowsing]);

  const retry = useCallback(() => {
    const actions = [...failedActions.current];
    if (actions.length) {
      return Promise.all(
        actions.map((write) => run(write.action, write.isRelevant))
      );
    }
    return refresh(true);
  }, [refresh, run]);

  return {
    data,
    browsing,
    updateBrowse,
    accept,
    run,
    select,
    refresh,
    retry,
    errorKey,
    saveStatus,
    loading,
  };
}
