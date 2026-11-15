import { randomUUID } from "node:crypto";
import path from "node:path";
import { and, count, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { getDatabase } from "@/db";
import {
  albumPhotos,
  cullSessionPhotos,
  faceVectors,
  folders,
  photos,
  photoTags,
} from "@/db/schema";
import {
  LIBRARY_SOURCE_STATUSES,
  type LibraryStatusFilter,
} from "@/types/library-reliability";
import { registerGalleryCleanup } from "@/utils/gallery-lifecycle";
import { importPathKey } from "@/utils/import-path";
import { notifyLibraryChange } from "./library-change";
import {
  observeLibraryPhoto,
  retryLibraryPhotoRefresh,
} from "./library-content-refresh";
import {
  getLibraryMoveCandidates,
  libraryMovePending,
} from "./library-move-candidates";
import {
  captureLibraryRelink,
  getRelinkInspection,
  inspectFolderRelink,
  inspectPhotoRelink,
  type RelinkWork,
} from "./library-relink";
import {
  getLibraryRootPaths,
  inspectLibraryPath,
  libraryPathCondition,
  libraryRootForPhoto,
  reconcileLibrarySources,
} from "./library-source";
import {
  libraryRefreshStatus,
  libraryStatusColumns,
  libraryStatusPredicate,
} from "./library-status-query";

const unavailableSource = inArray(photos.sourceStatus, [
  "offline",
  "missing",
  "inaccessible",
]);
const pendingMove =
  sql<number>`CASE WHEN ${libraryMovePending} THEN 1 ELSE 0 END`.mapWith(
    Number
  );
const needsAttention = or(
  inArray(photos.sourceStatus, ["missing", "inaccessible"]),
  eq(libraryRefreshStatus, "failed"),
  libraryMovePending
);

export type LibraryManageStatus =
  | LibraryStatusFilter
  | "attention"
  | "all"
  | "move";

function photoStatusCondition(status: LibraryManageStatus) {
  if (status === "attention") {
    return or(needsAttention, unavailableSource);
  }
  if (status === "move") {
    return libraryMovePending;
  }
  return status === "all" ? undefined : libraryStatusPredicate(status);
}

export function getLibraryIssues({
  folderId,
  status = "all",
  offset = 0,
}: {
  folderId?: number;
  status?: "all" | "offline" | "missing" | "inaccessible" | "failed";
  offset?: number;
} = {}) {
  return getLibraryPhotos({
    folderId,
    offset,
    status: status === "all" ? "attention" : status,
  });
}

function unassignedPhotoCondition() {
  const file =
    process.platform === "win32" ? sql`lower(${photos.path})` : photos.path;
  const folder =
    process.platform === "win32" ? sql`lower(${folders.path})` : folders.path;
  const prefix = sql`rtrim(${folder}, ${path.sep}) || ${path.sep}`;
  return and(
    isNull(photos.folderId),
    sql`NOT EXISTS (
    SELECT 1 FROM ${folders} WHERE substr(${file}, 1, length(${prefix})) = (${prefix})
  )`
  );
}

export function getLibraryPhotos({
  folderId,
  photoId,
  query,
  unassigned,
  status = "attention",
  offset = 0,
}: {
  folderId?: number;
  photoId?: number;
  query?: string;
  unassigned?: boolean;
  status?: LibraryManageStatus;
  offset?: number;
} = {}) {
  const db = getDatabase();
  const scope = folderPath(db, folderId);
  const needle = query?.trim().toLowerCase();
  const condition = and(
    isNull(photos.deletedAt),
    unassigned ? unassignedPhotoCondition() : undefined,
    scope ? libraryPathCondition(photos.path, scope) : undefined,
    photoId === undefined ? undefined : eq(photos.id, photoId),
    photoId === undefined ? photoStatusCondition(status) : undefined,
    needle
      ? or(
          sql`instr(lower(${photos.filename}), ${needle}) > 0`,
          sql`instr(lower(${photos.path}), ${needle}) > 0`
        )
      : undefined
  );
  return {
    total:
      db.select({ value: count() }).from(photos).where(condition).get()
        ?.value ?? 0,
    offset,
    limit: 20,
    items: db
      .select({
        id: photos.id,
        folderId: photos.folderId,
        filename: photos.filename,
        thumbnailPath: photos.thumbnailPath,
        path: photos.path,
        pendingMoveCount: pendingMove,
        ...libraryStatusColumns,
      })
      .from(photos)
      .where(condition)
      .orderBy(
        sql`CASE ${photos.sourceStatus} WHEN 'inaccessible' THEN 0 WHEN 'missing' THEN 1 WHEN 'offline' THEN 3 ELSE 2 END`,
        photos.id
      )
      .limit(20)
      .offset(offset)
      .all(),
  };
}

export function getLibraryAttention() {
  return {
    offlineCount:
      getDatabase()
        .select({ value: count() })
        .from(photos)
        .where(
          and(isNull(photos.deletedAt), eq(photos.sourceStatus, "offline"))
        )
        .get()?.value ?? 0,
    attentionCount:
      getDatabase()
        .select({ value: count() })
        .from(photos)
        .where(and(isNull(photos.deletedAt), needsAttention))
        .get()?.value ?? 0,
  };
}

export function getLibraryPhotoMoveCandidates(photoId: number) {
  return getLibraryMoveCandidates(getDatabase(), photoId);
}

type Db = ReturnType<typeof getDatabase>;
type Photo = typeof photos.$inferSelect;
export interface Scope {
  folderId?: number;
  photoIds?: number[];
}

interface LibraryTask {
  active: boolean;
  controller: AbortController;
  db: Db;
  dismissed?: boolean;
  errorCount: number;
  errors: { code: string; photoId?: number; path?: string }[];
  kind: "check" | "inspectRelink" | "applyRelink" | "retryUpdates";
  phase: "checking" | "validating" | "saving";
  preview?: ReturnType<typeof getRelinkInspection>;
  processed: number;
  relinkTarget?: {
    photoId?: number;
    folderId?: number;
    candidatePath?: string;
  };
  scope: Scope;
  selectedPath?: string;
  status: "queued" | "running" | "done" | "cancelled" | "failed";
  taskId: string;
  total: number;
  updated?: number;
}

interface FolderStats {
  attentionCount: number;
  failedCount: number;
  inaccessibleCount: number;
  missingCount: number;
  offlineCount: number;
  pendingMoveCount: number;
  total: number;
  unavailable: number;
}

function emptyFolderStats(): FolderStats {
  return {
    attentionCount: 0,
    pendingMoveCount: 0,
    total: 0,
    unavailable: 0,
    offlineCount: 0,
    missingCount: 0,
    failedCount: 0,
    inaccessibleCount: 0,
  };
}

interface Removal {
  db: Db;
  expiresAt: number;
  photos: Photo[];
}

const tasks = new Map<string, LibraryTask>();
const removals = new Map<string, Removal>();
const MAX_TASK_ERRORS = 1000;
const TASK_ERROR_PAGE_SIZE = 100;

function recordTaskError(
  task: LibraryTask,
  error: unknown,
  photo?: { id: number; path: string }
) {
  task.errorCount++;
  if (task.errors.length >= MAX_TASK_ERRORS) {
    return;
  }
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  task.errors.push({
    code: (
      code ??
      (error instanceof Error ? error.message : "LIBRARY_OPERATION_FAILED")
    ).slice(0, 300),
    photoId: photo?.id,
    path: photo?.path,
  });
}

function folderPath(db: Db, folderId?: number): string | undefined {
  if (folderId === undefined) {
    return undefined;
  }
  const folder = db
    .select({ path: folders.path })
    .from(folders)
    .where(eq(folders.id, folderId))
    .get();
  if (!folder) {
    throw new Error("LIBRARY_FOLDER_NOT_FOUND");
  }
  return folder.path;
}

export function getLibraryHealth(folderId?: number) {
  const db = getDatabase();
  const scope = folderPath(db, folderId);
  const active = and(
    isNull(photos.deletedAt),
    scope ? libraryPathCondition(photos.path, scope) : undefined
  );
  // Aggregate only catalogue fields. Health never probes original files.
  const rows = db
    .select({
      folderId: photos.folderId,
      orphanPath: sql<
        string | null
      >`CASE WHEN ${photos.folderId} IS NULL THEN ${photos.path} END`,
      sourceStatus: photos.sourceStatus,
      refreshStatus: libraryRefreshStatus,
      pendingMove,
      count: count(),
    })
    .from(photos)
    .where(active)
    .groupBy(
      photos.folderId,
      sql`2`,
      photos.sourceStatus,
      libraryRefreshStatus,
      pendingMove
    )
    .all();
  const counts = Object.fromEntries(
    LIBRARY_SOURCE_STATUSES.map((status) => [status, 0])
  ) as Record<(typeof LIBRARY_SOURCE_STATUSES)[number], number>;
  const folderRows = db
    .select({
      id: folders.id,
      path: folders.path,
      displayName: folders.displayName,
      sourceStatus: folders.sourceStatus,
      sourceCheckedAt: folders.sourceCheckedAt,
      lastScanResult: folders.lastScanResult,
    })
    .from(folders)
    .where(scope ? libraryPathCondition(folders.path, scope) : undefined)
    .orderBy(folders.displayName, folders.id)
    .all();
  const foldersByPath = new Map(
    folderRows.map((row) => [importPathKey(row.path), row.id])
  );
  const parents = new Map(
    folderRows.map((row) => [
      row.id,
      findAncestorFolder(path.dirname(row.path), foldersByPath, row.id),
    ])
  );
  const parentsOf = (id: number) => {
    const visited = new Set([id]);
    let parent = parents.get(id);
    while (parent !== undefined && !visited.has(parent)) {
      visited.add(parent);
      parent = parents.get(parent);
    }
    return visited;
  };
  const byFolder = new Map<number, FolderStats>();
  let total = 0;
  let unavailable = 0;
  let pending = 0;
  let failed = 0;
  let attentionCount = 0;
  let pendingMoveCount = 0;
  let unassignedCount = 0;
  for (const row of rows) {
    const inaccessible =
      row.sourceStatus !== "available" && row.sourceStatus !== "unverified";
    const attention =
      (inaccessible && row.sourceStatus !== "offline") ||
      row.refreshStatus === "failed" ||
      row.pendingMove !== 0;
    attentionCount += Number(attention) * row.count;
    pendingMoveCount += Number(Boolean(row.pendingMove)) * row.count;
    total += row.count;
    counts[row.sourceStatus] += row.count;
    unavailable += Number(inaccessible) * row.count;
    pending += Number(row.refreshStatus === "pending") * row.count;
    failed += Number(row.refreshStatus === "failed") * row.count;
    const owner =
      row.folderId ??
      (row.orphanPath
        ? findAncestorFolder(path.dirname(row.orphanPath), foldersByPath)
        : undefined);
    if (owner === undefined && (attention || inaccessible)) {
      unassignedCount += row.count;
    }
    if (owner !== undefined) {
      for (const id of parentsOf(owner)) {
        const stats = byFolder.get(id) ?? emptyFolderStats();
        stats.total += row.count;
        stats.offlineCount +=
          Number(row.sourceStatus === "offline") * row.count;
        stats.missingCount +=
          Number(row.sourceStatus === "missing") * row.count;
        stats.inaccessibleCount +=
          Number(row.sourceStatus === "inaccessible") * row.count;
        stats.failedCount += Number(row.refreshStatus === "failed") * row.count;
        stats.unavailable += Number(inaccessible) * row.count;
        stats.attentionCount += Number(attention) * row.count;
        stats.pendingMoveCount += Number(Boolean(row.pendingMove)) * row.count;
        byFolder.set(id, stats);
      }
    }
  }
  return {
    counts,
    offlineCount: counts.offline,
    unassignedCount,
    total,
    unavailable,
    attentionCount,
    pendingMoveCount,
    pending,
    failed,
    folders: folderRows.map((folder) => ({
      ...folder,
      parentId: parents.get(folder.id) ?? null,
      rootId: [...parentsOf(folder.id)].at(-1) ?? folder.id,
      ...(byFolder.get(folder.id) ?? emptyFolderStats()),
    })),
  };
}

function findAncestorFolder(
  directory: string,
  foldersByPath: ReadonlyMap<string, number>,
  omit?: number
): number | undefined {
  let current = directory;
  for (;;) {
    const id = foldersByPath.get(importPathKey(current));
    if (id !== undefined && id !== omit) {
      return id;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return;
    }
    current = parent;
  }
}

function viewTask(task: LibraryTask, offset = 0) {
  const photoId =
    task.scope.photoIds?.length === 1 ? task.scope.photoIds[0] : undefined;
  return {
    taskId: task.taskId,
    status: task.status,
    kind: task.kind,
    phase: task.phase,
    scope: task.scope,
    cancellable:
      task.active && task.phase !== "saving" && !task.controller.signal.aborted,
    total: task.total,
    processed: task.processed,
    errors: task.errors
      .slice(offset, offset + TASK_ERROR_PAGE_SIZE)
      .map((error) => error.code),
    errorDetails: task.errors.slice(offset, offset + TASK_ERROR_PAGE_SIZE),
    errorCount: task.errorCount,
    errorOffset: offset,
    errorLimit: TASK_ERROR_PAGE_SIZE,
    storedErrorCount: task.errors.length,
    hasMoreErrors: offset + TASK_ERROR_PAGE_SIZE < task.errors.length,
    preview: task.preview,
    updated: task.updated,
    photoStatus:
      task.status === "done" && photoId
        ? (task.db
            .select(libraryStatusColumns)
            .from(photos)
            .where(eq(photos.id, photoId))
            .get() ?? null)
        : null,
  };
}

function currentTask(taskId: string) {
  const task = tasks.get(taskId);
  if (!task || task.db !== getDatabase()) {
    throw new Error("LIBRARY_TASK_NOT_FOUND");
  }
  return task;
}

export function getLibraryTask(taskId: string, offset: number) {
  return viewTask(currentTask(taskId), offset);
}

export function getActiveLibraryTask() {
  const task = [...tasks.values()]
    .reverse()
    .find((item) => item.db === getDatabase() && !item.dismissed);
  return task ? viewTask(task) : null;
}

export function dismissLibraryTask(taskId: string) {
  const task = currentTask(taskId);
  if (!task.active) {
    task.dismissed = true;
  }
  return { dismissed: !task.active };
}

export function cancelLibraryTask(taskId: string) {
  const task = currentTask(taskId);
  if (task.active && task.phase !== "saving") {
    task.controller.abort();
    task.status = "cancelled";
  }
  return viewTask(task);
}

export function cancelLibraryMaintenance(): void {
  for (const task of tasks.values()) {
    task.controller.abort();
  }
  removals.clear();
}
registerGalleryCleanup(cancelLibraryMaintenance);

function createTask(kind: LibraryTask["kind"], scope: Scope, total: number) {
  const db = getDatabase();
  if ([...tasks.values()].some((task) => task.db === db && task.active)) {
    throw new Error("LIBRARY_TASK_BUSY");
  }
  for (const [id, task] of tasks) {
    if (!task.active) {
      task.dismissed = true;
    }
    if (task.db !== db || tasks.size >= 24) {
      task.controller.abort();
      tasks.delete(id);
    }
  }
  const task: LibraryTask = {
    db,
    controller: new AbortController(),
    taskId: randomUUID(),
    kind,
    phase: kind === "applyRelink" ? "validating" : "checking",
    scope,
    status: "queued",
    active: true,
    processed: 0,
    errors: [],
    errorCount: 0,
    total,
  };
  tasks.set(task.taskId, task);
  return task;
}

function relinkWork(task: LibraryTask): RelinkWork {
  return {
    signal: task.controller.signal,
    isCurrent: () => task.db === getDatabase(),
    onProgress: ({ processed, total, phase }) => {
      task.processed = processed;
      task.total = total;
      task.phase = phase;
    },
  };
}

function scheduleTask(task: LibraryTask, run: () => Promise<void>) {
  setImmediate(async () => {
    try {
      task.controller.signal.throwIfAborted();
      if (task.db !== getDatabase()) {
        throw new Error("RELINK_STALE");
      }
      task.status = "running";
      await run();
      task.status = task.controller.signal.aborted ? "cancelled" : "done";
    } catch (error) {
      task.status = task.controller.signal.aborted ? "cancelled" : "failed";
      if (task.status === "failed") {
        recordTaskError(task, error);
      }
    } finally {
      task.active = false;
    }
  });
  return viewTask(task);
}

export function reconcileLibrary(scope: Scope) {
  const db = getDatabase();
  const directory = folderPath(db, scope.folderId);
  const total =
    db
      .select({ value: count() })
      .from(photos)
      .where(
        and(
          isNull(photos.deletedAt),
          directory ? libraryPathCondition(photos.path, directory) : undefined,
          scope.photoIds ? inArray(photos.id, scope.photoIds) : undefined
        )
      )
      .get()?.value ?? 0;
  const task = createTask("check", scope, total);
  return scheduleTask(task, async () => {
    const result = await reconcileLibrarySources({
      folderPath: directory,
      photoIds: scope.photoIds,
      signal: task.controller.signal,
      isCurrent: () =>
        !task.controller.signal.aborted && task.db === getDatabase(),
      onAvailable: async ({ id, path }) => {
        try {
          await observeLibraryPhoto(id, path);
        } catch (error) {
          if (!task.controller.signal.aborted && task.db === getDatabase()) {
            recordTaskError(task, error, { id, path });
          }
        }
      },
      onProgress: (summary) => {
        task.processed = summary.checked;
      },
    });
    if (result.changed && task.db === getDatabase()) {
      notifyLibraryChange(null, "status");
    }
  });
}

export function beginLibraryRelink(
  target: { photoId?: number; folderId?: number; candidatePath?: string },
  selectedPath: string
) {
  if (
    target.candidatePath &&
    !(
      target.photoId &&
      getLibraryPhotoMoveCandidates(target.photoId).some(
        (candidate) =>
          importPathKey(candidate.targetPath) === importPathKey(selectedPath)
      )
    )
  ) {
    throw new Error("RELINK_STALE");
  }
  const scope = target.photoId
    ? { photoIds: [target.photoId] }
    : { folderId: target.folderId };
  const task = createTask("inspectRelink", scope, 0);
  task.relinkTarget = target;
  task.selectedPath = selectedPath;
  const photoId = target.photoId;
  const folderId = target.folderId;
  return scheduleTask(task, async () => {
    task.preview =
      photoId === undefined
        ? await inspectFolderRelink(
            folderId ?? 0,
            selectedPath,
            relinkWork(task)
          )
        : await inspectPhotoRelink(photoId, selectedPath, relinkWork(task));
  });
}

export function retryLibraryRelink(taskId: string) {
  const task = currentTask(taskId);
  if (!(task.relinkTarget && task.selectedPath)) {
    throw new Error("RELINK_EXPIRED");
  }
  return beginLibraryRelink(task.relinkTarget, task.selectedPath);
}

export function beginApplyLibraryRelink(
  token: string,
  confirmedPhotoIds: number[]
) {
  const admitted = captureLibraryRelink(token);
  const task = createTask("applyRelink", admitted.scope, admitted.total);
  task.preview = getRelinkInspection(token, 0);
  const inspection = [...tasks.values()].find(
    (item) => item.preview?.token === token && item.selectedPath
  );
  task.relinkTarget = inspection?.relinkTarget;
  task.selectedPath = inspection?.selectedPath;
  return scheduleTask(task, async () => {
    const result = await admitted.apply(confirmedPhotoIds, relinkWork(task));
    task.updated = result.updated;
    task.preview = undefined;
  });
}

export async function inspectMissingRecordRemoval(photoIds: number[]) {
  const db = getDatabase();
  const records = db
    .select()
    .from(photos)
    .where(
      and(
        inArray(photos.id, photoIds),
        isNull(photos.deletedAt),
        eq(photos.sourceStatus, "missing")
      )
    )
    .all();
  const roots = getLibraryRootPaths(db);
  const missing: Photo[] = [];
  for (const photo of records) {
    if (
      (
        await inspectLibraryPath(
          photo.path,
          libraryRootForPhoto(roots, photo.path)
        )
      ).status === "missing"
    ) {
      missing.push(photo);
    }
  }
  if (db !== getDatabase()) {
    throw new Error("LIBRARY_REMOVAL_STALE");
  }
  const ids = missing.map((photo) => photo.id);
  const token = randomUUID();
  for (const [key, value] of removals) {
    if (
      value.expiresAt < Date.now() ||
      value.db !== db ||
      removals.size >= 12
    ) {
      removals.delete(key);
    }
  }
  removals.set(token, { db, expiresAt: Date.now() + 600_000, photos: missing });
  return {
    token,
    photoIds: ids,
    links: {
      tags:
        db
          .select({ value: count() })
          .from(photoTags)
          .where(inArray(photoTags.photoId, ids))
          .get()?.value ?? 0,
      albums:
        db
          .select({ value: count() })
          .from(albumPhotos)
          .where(inArray(albumPhotos.photoId, ids))
          .get()?.value ?? 0,
      faces:
        db
          .select({ value: count() })
          .from(faceVectors)
          .where(inArray(faceVectors.photoId, ids))
          .get()?.value ?? 0,
      cull:
        db
          .select({ value: count() })
          .from(cullSessionPhotos)
          .where(inArray(cullSessionPhotos.photoId, ids))
          .get()?.value ?? 0,
    },
  };
}

export async function removeMissingRecords(
  token: string,
  remove: (photoIds: number[]) => void
) {
  const confirmation = removals.get(token);
  removals.delete(token);
  const db = getDatabase();
  if (
    !confirmation ||
    confirmation.db !== db ||
    confirmation.expiresAt < Date.now()
  ) {
    throw new Error("LIBRARY_REMOVAL_EXPIRED");
  }
  const roots = getLibraryRootPaths(db);
  for (const photo of confirmation.photos) {
    const source = await inspectLibraryPath(
      photo.path,
      libraryRootForPhoto(roots, photo.path)
    );
    if (source.status !== "missing") {
      throw new Error("LIBRARY_REMOVAL_STALE");
    }
  }
  if (confirmation.db !== getDatabase()) {
    throw new Error("LIBRARY_REMOVAL_STALE");
  }
  const ids = confirmation.photos.map((photo) => photo.id);
  for (const photo of confirmation.photos) {
    const current = db
      .select()
      .from(photos)
      .where(eq(photos.id, photo.id))
      .get();
    if (
      !current ||
      current.path !== photo.path ||
      current.fileRevision !== photo.fileRevision ||
      current.deletedAt !== null ||
      current.sourceStatus !== "missing"
    ) {
      throw new Error("LIBRARY_REMOVAL_STALE");
    }
  }
  remove(ids);
  if (ids.length) {
    notifyLibraryChange(null, "remove");
  }
  return { removed: ids.length };
}

export function retryLibrarySourceUpdates(folderId: number) {
  const db = getDatabase();
  const scope = folderPath(db, folderId);
  const records = db
    .select({ id: photos.id, path: photos.path })
    .from(photos)
    .where(
      and(
        isNull(photos.deletedAt),
        eq(photos.sourceStatus, "available"),
        eq(libraryRefreshStatus, "failed"),
        scope ? libraryPathCondition(photos.path, scope) : undefined
      )
    )
    .all();
  const task = createTask("retryUpdates", { folderId }, records.length);
  return scheduleTask(task, async () => {
    for (const photo of records) {
      task.controller.signal.throwIfAborted();
      if (task.db !== getDatabase()) {
        throw new Error("RELINK_STALE");
      }
      try {
        if (!(await retryLibraryPhotoRefresh(photo.id))) {
          recordTaskError(task, new Error("LIBRARY_OPERATION_FAILED"), photo);
        }
      } catch (error) {
        recordTaskError(task, error, photo);
      }
      task.processed++;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  });
}
