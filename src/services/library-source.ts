import fs from "node:fs";
import path from "node:path";
import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { getDatabase } from "@/db";
import { folders, photos } from "@/db/schema";
import type { LibrarySourceStatus } from "@/types/library-reliability";
import { GALLERY_CONFIG } from "@/utils/gallery-config";
import { importPathKey } from "@/utils/import-path";
import { containsLibraryPath, selectLibraryRoots } from "@/utils/library-roots";

type LibraryDb = ReturnType<typeof getDatabase>;
type RootStatus = Exclude<LibrarySourceStatus, "unverified" | "missing">;
interface Probe {
  errorCode?: string;
  status: LibrarySourceStatus;
}
export type LibraryFileObservation = Pick<
  fs.Stats,
  "size" | "mtimeMs" | "ctimeMs"
>;

interface FileProbe extends Probe {
  observation?: LibraryFileObservation;
}
interface RootProbe {
  errorCode?: string;
  status: RootStatus;
}
interface ObservedPhoto {
  fileRevision: number;
  id: number;
  path: string;
}

const PHOTO_BATCH = 200;
const SOURCE_WORK_SLICE_MS = 4;
const PROBE_TIMEOUT_MS = 5000;
const pausedScopes = new Set<string>();

export function librarySourceIsPaused(filePath: string): boolean {
  return [...pausedScopes].some(
    (scope) =>
      containsLibraryPath(scope, filePath) ||
      containsLibraryPath(filePath, scope)
  );
}

export async function withLibrarySourcesPaused<T>(
  scopes: readonly string[],
  operation: () => Promise<T>
): Promise<T> {
  if (scopes.some(librarySourceIsPaused)) {
    throw new Error("LIBRARY_SOURCE_BUSY");
  }
  const keys = scopes.map(importPathKey);
  for (const key of keys) {
    pausedScopes.add(key);
  }
  try {
    return await operation();
  } finally {
    for (const key of keys) {
      pausedScopes.delete(key);
    }
  }
}

function errorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException | undefined)?.code ?? "UNKNOWN";
}

function notFound(code: string): boolean {
  return code === "ENOENT" || code === "ENOTDIR";
}

async function boundedProbe<T>(run: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              Object.assign(new Error("Source probe timed out"), {
                code: "ETIMEDOUT",
              })
            ),
          PROBE_TIMEOUT_MS
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function inspectLibraryRoot(rootPath: string): Promise<RootProbe> {
  try {
    await boundedProbe(async () => {
      const dir = await fs.promises.opendir(rootPath);
      await dir.close();
    });
    return { status: "available" };
  } catch (error) {
    const code = errorCode(error);
    return {
      status: notFound(code) ? "offline" : "inaccessible",
      errorCode: code,
    };
  }
}

async function inspectFileInOnlineRoot(
  filePath: string,
  rootPath: string
): Promise<FileProbe> {
  try {
    const observation = await boundedProbe(async () => {
      await fs.promises.access(filePath, fs.constants.R_OK);
      const stat = await fs.promises.stat(filePath);
      if (!stat.isFile()) {
        throw Object.assign(new Error("Source is not a file"), {
          code: "NOT_FILE",
        });
      }
      const { size, mtimeMs, ctimeMs } = stat;
      return { size, mtimeMs, ctimeMs };
    });
    return { status: "available", observation };
  } catch (error) {
    const code = errorCode(error);
    if (!notFound(code)) {
      return { status: "inaccessible", errorCode: code };
    }
    const root = await inspectLibraryRoot(rootPath);
    return root.status === "available"
      ? { status: "missing", errorCode: code }
      : root;
  }
}

export async function inspectLibraryPath(
  filePath: string,
  rootPath: string
): Promise<Probe> {
  if (!containsLibraryPath(rootPath, filePath)) {
    return { status: "inaccessible", errorCode: "OUTSIDE_SOURCE" };
  }
  const root = await inspectLibraryRoot(rootPath);
  if (root.status !== "available") {
    return root;
  }
  const result = await inspectFileInOnlineRoot(filePath, rootPath);
  return result.status === "available" ? { status: "available" } : result;
}

export function getLibraryRootPaths(db: LibraryDb): string[] {
  const rows = db
    .select({ path: folders.path, explicitOnly: folders.explicitOnly })
    .from(folders)
    .all();
  const monitored = selectLibraryRoots(rows.filter((row) => !row.explicitOnly));
  const explicit = selectLibraryRoots(
    rows.filter(
      (row) =>
        row.explicitOnly &&
        !monitored.some((root) => containsLibraryPath(root.path, row.path))
    )
  );
  return [...monitored, ...explicit].map((root) => root.path);
}

export function libraryRootForPhoto(
  roots: readonly string[],
  filePath: string
): string {
  return (
    roots.find((root) => containsLibraryPath(root, filePath)) ??
    path.dirname(filePath)
  );
}

export function libraryPathCondition(
  column: typeof photos.path | typeof folders.path,
  scope: string
) {
  const key = importPathKey(path.resolve(scope));
  const prefix = key.endsWith(path.sep) ? key : key + path.sep;
  const value = process.platform === "win32" ? sql`lower(${column})` : column;
  return sql`(${value} = ${key} OR substr(${value}, 1, ${prefix.length}) = ${prefix})`;
}

function preparePhotoSourceWriter(db: LibraryDb) {
  const condition = and(
    eq(photos.id, sql.placeholder("id")),
    eq(photos.path, sql.placeholder("path")),
    eq(photos.fileRevision, sql.placeholder("fileRevision")),
    isNull(photos.deletedAt),
    sql`(${photos.sourceCheckedAt} IS NULL OR ${photos.sourceCheckedAt} <= ${sql.placeholder("checkedAt")})`
  );
  const read = db
    .select({ status: photos.sourceStatus })
    .from(photos)
    .where(condition)
    .prepare();
  const write = db
    .update(photos)
    .set({
      sourceStatus: sql`${sql.placeholder("status")}`,
      sourceCheckedAt: sql`${sql.placeholder("checkedAt")}`,
      sourceErrorCode: sql`${sql.placeholder("errorCode")}`,
      sourceAvailableAt: sql`CASE WHEN ${sql.placeholder("status")} = 'available' THEN ${sql.placeholder("checkedAt")} ELSE ${photos.sourceAvailableAt} END`,
      sourceMissingAt: sql`CASE WHEN ${sql.placeholder("status")} = 'available' THEN NULL WHEN ${sql.placeholder("status")} = 'missing' THEN coalesce(${photos.sourceMissingAt}, ${sql.placeholder("checkedAt")}) ELSE ${photos.sourceMissingAt} END`,
    })
    .where(condition)
    .prepare();
  return { read, write };
}

// A scan updates every observed record. Reuse SQL compilation per connection;
// the placeholders still check the current path, revision and observation time.
const photoSourceWriters = new WeakMap<
  LibraryDb,
  ReturnType<typeof preparePhotoSourceWriter>
>();

function applyLibraryPhotoSource(
  db: LibraryDb,
  photo: ObservedPhoto,
  result: Probe,
  checkedAt: number
): boolean | undefined {
  let writer = photoSourceWriters.get(db);
  if (!writer) {
    writer = preparePhotoSourceWriter(db);
    photoSourceWriters.set(db, writer);
  }
  const parameters = {
    ...photo,
    checkedAt,
    status: result.status,
    errorCode: result.errorCode ?? null,
  };
  const current = writer.read.get(parameters);
  if (!current) {
    return;
  }
  writer.write.run(parameters);
  return current.status !== result.status;
}

export function writeLibraryPhotoSource(
  db: LibraryDb,
  photo: ObservedPhoto,
  result: Probe,
  checkedAt: number
): boolean {
  return applyLibraryPhotoSource(db, photo, result, checkedAt) ?? false;
}

export function writeLibraryFolderSource(
  db: LibraryDb,
  folderPath: string,
  result: RootProbe,
  checkedAt: number,
  scanResult?: typeof folders.$inferSelect.lastScanResult
): void {
  const key = importPathKey(path.resolve(folderPath));
  const value =
    process.platform === "win32" ? sql`lower(${folders.path})` : folders.path;
  db.update(folders)
    .set({
      sourceStatus: result.status,
      sourceCheckedAt: checkedAt,
      ...(scanResult === undefined ? {} : { lastScanResult: scanResult }),
    })
    .where(
      and(
        sql`${value} = ${key}`,
        sql`(${folders.sourceCheckedAt} IS NULL OR ${folders.sourceCheckedAt} <= ${checkedAt})`
      )
    )
    .run();
}

export interface LibrarySourceSummary {
  available: number;
  changed: number;
  checked: number;
  inaccessible: number;
  missing: number;
  offline: number;
}

interface SourceCheckOptions {
  explicitOnly?: boolean;
  folderPath?: string;
  isCurrent?: () => boolean;
  onAvailable?: (
    photo: ObservedPhoto,
    observation?: LibraryFileObservation
  ) => Promise<unknown>;
  onProgress?: (summary: LibrarySourceSummary) => void;
  photoIds?: number[];
  signal?: AbortSignal;
  unavailableRootsOnly?: boolean;
  unseenPaths?: ReadonlySet<string>;
}

export async function reconcileLibrarySources(
  options: SourceCheckOptions = {}
): Promise<LibrarySourceSummary> {
  const db = getDatabase();
  const roots = getLibraryRootPaths(db);
  const rootChecks = new Map<string, Promise<RootProbe>>();
  const current = () =>
    !options.signal?.aborted &&
    getDatabase() === db &&
    (options.isCurrent?.() ?? true);
  const checkedAt = Date.now();
  const getRoot = (root: string) => {
    let probe = rootChecks.get(root);
    if (!probe) {
      probe = inspectLibraryRoot(root).then((result) => {
        if (current()) {
          writeLibraryFolderSource(
            db,
            root,
            result,
            checkedAt,
            result.status === "available" ? undefined : result.status
          );
        }
        return result;
      });
      rootChecks.set(root, probe);
    }
    return probe;
  };
  const result: LibrarySourceSummary = {
    checked: 0,
    changed: 0,
    available: 0,
    missing: 0,
    offline: 0,
    inaccessible: 0,
  };
  const check = async (photo: ObservedPhoto) => {
    if (librarySourceIsPaused(photo.path)) {
      return;
    }
    const root = libraryRootForPhoto(roots, photo.path);
    const rootProbe = await getRoot(root);
    if (!current() || librarySourceIsPaused(photo.path)) {
      return;
    }
    // The startup pass only propagates unavailable roots. Online files are
    // checked by the normal scan/explicit-source pass, without duplicate I/O.
    if (options.unavailableRootsOnly && rootProbe.status === "available") {
      return;
    }
    const probe: FileProbe =
      rootProbe.status === "available"
        ? await inspectFileInOnlineRoot(photo.path, root)
        : rootProbe;
    if (
      !current() ||
      librarySourceIsPaused(photo.path) ||
      probe.status === "unverified"
    ) {
      return;
    }
    return { photo, probe: { ...probe, status: probe.status } };
  };
  let cursor = 0;
  while (current()) {
    const batch = db
      .select({
        id: photos.id,
        path: photos.path,
        fileRevision: photos.fileRevision,
      })
      .from(photos)
      .where(
        and(
          gt(photos.id, cursor),
          isNull(photos.deletedAt),
          options.folderPath
            ? libraryPathCondition(photos.path, options.folderPath)
            : undefined,
          options.photoIds ? inArray(photos.id, options.photoIds) : undefined,
          options.explicitOnly
            ? sql`(${photos.folderId} IS NULL OR ${photos.folderId} IN (SELECT id FROM folders WHERE explicit_only = 1))`
            : undefined
        )
      )
      .orderBy(photos.id)
      .limit(PHOTO_BATCH)
      .all();
    if (!batch.length) {
      break;
    }
    cursor = batch.at(-1)?.id ?? cursor;
    const candidates = batch.filter(
      (photo) => !options.unseenPaths?.has(importPathKey(photo.path))
    );
    const observations: NonNullable<Awaited<ReturnType<typeof check>>>[] = [];
    let next = 0;
    await Promise.all(
      Array.from(
        // Leave I/O capacity for foreground previews while checking originals.
        { length: GALLERY_CONFIG.sourceCheckConcurrency },
        async () => {
          let sliceStarted = performance.now();
          while (current() && next < candidates.length) {
            if (performance.now() - sliceStarted >= SOURCE_WORK_SLICE_MS) {
              await new Promise<void>((resolve) => setImmediate(resolve));
              sliceStarted = performance.now();
              if (!current() || next >= candidates.length) {
                break;
              }
            }
            const observation = await check(candidates[next++]);
            if (observation) {
              observations.push(observation);
            }
          }
        }
      )
    );
    if (!current()) {
      break;
    }
    // Probe asynchronously first, then commit the page on the same connection.
    // Keeping awaits outside the transaction also lets callbacks observe the
    // committed source state without holding SQLite's write lock during I/O.
    const committed = db.transaction(() =>
      observations.flatMap(({ photo, probe }) => {
        if (librarySourceIsPaused(photo.path)) {
          return [];
        }
        const changed = applyLibraryPhotoSource(db, photo, probe, checkedAt);
        return [{ photo, probe, changed }];
      })
    );
    for (const { probe, changed } of committed) {
      result.checked++;
      result[probe.status]++;
      if (changed) {
        result.changed++;
      }
    }
    next = 0;
    await Promise.all(
      Array.from(
        { length: GALLERY_CONFIG.sourceCheckConcurrency },
        async () => {
          let sliceStarted = performance.now();
          while (current() && next < committed.length) {
            if (performance.now() - sliceStarted >= SOURCE_WORK_SLICE_MS) {
              await new Promise<void>((resolve) => setImmediate(resolve));
              sliceStarted = performance.now();
              if (!current() || next >= committed.length) {
                break;
              }
            }
            const { photo, probe, changed } = committed[next++];
            if (
              changed !== undefined &&
              probe.status === "available" &&
              !librarySourceIsPaused(photo.path)
            ) {
              await options.onAvailable?.(photo, probe.observation);
            }
          }
        }
      )
    );
    options.onProgress?.({ ...result });
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return result;
}
