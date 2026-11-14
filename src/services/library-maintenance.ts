import { randomUUID } from "node:crypto";
import { and, count, eq, inArray, isNull, or } from "drizzle-orm";
import { getDatabase } from "@/db";
import {
  albumPhotos,
  cullSessionPhotos,
  faceVectors,
  folders,
  photos,
  photoTags,
} from "@/db/schema";
import { LIBRARY_SOURCE_STATUSES } from "@/types/library-reliability";
import { registerGalleryCleanup } from "@/utils/gallery-lifecycle";
import { notifyLibraryChange } from "./library-change";
import { observeLibraryPhoto } from "./library-content-refresh";
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
} from "./library-status-query";

export function getLibraryIssues({
  folderId,
  status = "all",
  offset = 0,
}: {
  folderId?: number;
  status?: "all" | "offline" | "missing" | "inaccessible" | "failed";
  offset?: number;
} = {}) {
  const db = getDatabase();
  const scope = folderPath(db, folderId);
  let issueCondition = or(
    inArray(photos.sourceStatus, ["offline", "missing", "inaccessible"]),
    eq(libraryRefreshStatus, "failed")
  );
  if (status === "failed") {
    issueCondition = eq(libraryRefreshStatus, "failed");
  } else if (status !== "all") {
    issueCondition = eq(photos.sourceStatus, status);
  }
  const condition = and(
    isNull(photos.deletedAt),
    scope ? libraryPathCondition(photos.path, scope) : undefined,
    issueCondition
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
        filename: photos.filename,
        thumbnailPath: photos.thumbnailPath,
        path: photos.path,
        ...libraryStatusColumns,
      })
      .from(photos)
      .where(condition)
      .orderBy(photos.id)
      .limit(20)
      .offset(offset)
      .all(),
  };
}

type Db = ReturnType<typeof getDatabase>;
type Photo = typeof photos.$inferSelect;
interface Scope {
  folderId?: number;
  photoIds?: number[];
}

interface LibraryTask {
  controller: AbortController;
  db: Db;
  errors: string[];
  photoId?: number;
  processed: number;
  status: "queued" | "running" | "done" | "cancelled" | "failed";
  taskId: string;
  total: number;
}

interface Removal {
  db: Db;
  expiresAt: number;
  photos: Photo[];
}

const tasks = new Map<string, LibraryTask>();
const removals = new Map<string, Removal>();

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
      sourceStatus: photos.sourceStatus,
      refreshStatus: libraryRefreshStatus,
      count: count(),
    })
    .from(photos)
    .where(active)
    .groupBy(photos.folderId, photos.sourceStatus, libraryRefreshStatus)
    .all();
  const counts = Object.fromEntries(
    LIBRARY_SOURCE_STATUSES.map((status) => [status, 0])
  ) as Record<(typeof LIBRARY_SOURCE_STATUSES)[number], number>;
  const byFolder = new Map<number, { total: number; unavailable: number }>();
  let total = 0;
  let unavailable = 0;
  let pending = 0;
  let failed = 0;
  let attentionCount = 0;
  for (const row of rows) {
    const inaccessible =
      row.sourceStatus !== "available" && row.sourceStatus !== "unverified";
    attentionCount +=
      inaccessible || row.refreshStatus === "failed" ? row.count : 0;
    total += row.count;
    counts[row.sourceStatus] += row.count;
    unavailable += inaccessible ? row.count : 0;
    pending += row.refreshStatus === "pending" ? row.count : 0;
    failed += row.refreshStatus === "failed" ? row.count : 0;
    if (row.folderId !== null) {
      const stats = byFolder.get(row.folderId) ?? { total: 0, unavailable: 0 };
      stats.total += row.count;
      stats.unavailable += inaccessible ? row.count : 0;
      byFolder.set(row.folderId, stats);
    }
  }
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
    .all();
  return {
    counts,
    total,
    unavailable,
    attentionCount,
    pending,
    failed,
    folders: folderRows.map((folder) => ({
      ...folder,
      ...(byFolder.get(folder.id) ?? { total: 0, unavailable: 0 }),
    })),
  };
}

function viewTask(task: LibraryTask, offset = 0) {
  return {
    taskId: task.taskId,
    status: task.status,
    total: task.total,
    processed: task.processed,
    errors: task.errors.slice(offset, offset + 100),
    photoStatus:
      task.status === "done" && task.photoId
        ? (task.db
            .select(libraryStatusColumns)
            .from(photos)
            .where(eq(photos.id, task.photoId))
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

export function cancelLibraryTask(taskId: string) {
  const task = currentTask(taskId);
  if (task.status === "queued" || task.status === "running") {
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

export function reconcileLibrary(scope: Scope) {
  const db = getDatabase();
  const directory = folderPath(db, scope.folderId);
  const current = [...tasks.values()].find(
    (task) =>
      task.db === db && (task.status === "queued" || task.status === "running")
  );
  if (current) {
    throw new Error("LIBRARY_TASK_BUSY");
  }
  for (const [id, task] of tasks) {
    if (task.db !== db || tasks.size >= 24) {
      task.controller.abort();
      tasks.delete(id);
    }
  }
  const task: LibraryTask = {
    db,
    controller: new AbortController(),
    taskId: randomUUID(),
    photoId: scope.photoIds?.length === 1 ? scope.photoIds[0] : undefined,
    status: "queued",
    processed: 0,
    errors: [],
    total:
      db
        .select({ value: count() })
        .from(photos)
        .where(
          and(
            isNull(photos.deletedAt),
            directory
              ? libraryPathCondition(photos.path, directory)
              : undefined,
            scope.photoIds ? inArray(photos.id, scope.photoIds) : undefined
          )
        )
        .get()?.value ?? 0,
  };
  tasks.set(task.taskId, task);
  setImmediate(() => {
    runLibraryTask(task, directory, scope.photoIds).catch(() => undefined);
  });
  return viewTask(task);
}

async function runLibraryTask(
  task: LibraryTask,
  directory?: string,
  photoIds?: number[]
): Promise<void> {
  const { signal } = task.controller;
  if (signal.aborted || task.db !== getDatabase()) {
    task.status = "cancelled";
    return;
  }
  task.status = "running";
  try {
    const result = await reconcileLibrarySources({
      folderPath: directory,
      photoIds,
      signal,
      isCurrent: () => !signal.aborted && task.db === getDatabase(),
      onAvailable: async ({ id, path }) => {
        await observeLibraryPhoto(id, path);
      },
      onProgress: (summary) => {
        task.processed = summary.checked;
      },
    });
    task.status = signal.aborted ? "cancelled" : "done";
    if (result.changed && !signal.aborted && task.db === getDatabase()) {
      notifyLibraryChange(null, "status");
    }
  } catch (error) {
    task.status = signal.aborted ? "cancelled" : "failed";
    task.errors.push(
      (error as NodeJS.ErrnoException).code ?? "LIBRARY_RECONCILE_FAILED"
    );
  }
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
