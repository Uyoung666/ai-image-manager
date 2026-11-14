import fs from "node:fs";
import path from "node:path";
import {
  and,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  sql,
} from "drizzle-orm";
import PQueue from "p-queue";
import { getDatabase } from "@/db";
import { folders, photos } from "@/db/schema";
import { invalidateFoldersCache } from "@/utils/folder-paths";
import { importPathKey } from "@/utils/import-path";
import { createLogger } from "@/utils/logger";
import { computeFullFileHash, FULL_FILE_HASH_VERSION } from "./file-hash";
import {
  getLibraryRootPaths,
  inspectLibraryPath,
  libraryRootForPhoto,
} from "./library-source";

type LibraryDb = ReturnType<typeof getDatabase>;
type StoredPhoto = typeof photos.$inferSelect;

const log = createLogger("library-moves");
const hashQueue = new PQueue({ concurrency: 1 });

export function libraryPhotoPathEquals(filePath: string) {
  return process.platform === "win32"
    ? sql`lower(${photos.path}) = ${importPathKey(filePath)}`
    : eq(photos.path, filePath);
}

export function libraryPhotoPathsIn(filePaths: string[]) {
  return process.platform === "win32"
    ? inArray(sql`lower(${photos.path})`, filePaths.map(importPathKey))
    : inArray(photos.path, filePaths);
}

/** Windows can change spelling without changing which file a path identifies. */
export function acceptLibraryPathSpelling(
  db: LibraryDb,
  photo: { id: number; path: string },
  filePath: string
): void {
  if (
    process.platform !== "win32" ||
    photo.path === filePath ||
    importPathKey(photo.path) !== importPathKey(filePath)
  ) {
    return;
  }
  db.update(photos)
    .set({
      path: filePath,
      filename: path.basename(filePath),
      fileRevision: sql`${photos.fileRevision} + 1`,
      sourceHashFileRevision: sql`CASE WHEN ${photos.sourceHashFileRevision} = ${photos.fileRevision}
      THEN ${photos.fileRevision} + 1 ELSE NULL END`,
    })
    .where(and(eq(photos.id, photo.id), eq(photos.path, photo.path)))
    .run();
}

export async function hashLibraryFile(
  filePath: string,
  priority = 1
): Promise<string | null> {
  return (
    (await hashQueue.add(() => computeFullFileHash(filePath), { priority })) ??
    null
  );
}

function sameStat(first: fs.Stats, last: fs.Stats): boolean {
  return (
    first.size === last.size &&
    first.mtimeMs === last.mtimeMs &&
    first.ctimeMs === last.ctimeMs &&
    first.ino === last.ino &&
    first.dev === last.dev
  );
}

async function readStat(filePath: string): Promise<fs.Stats | null> {
  try {
    const stat = await fs.promises.stat(filePath);
    return stat.isFile() ? stat : null;
  } catch {
    return null;
  }
}

interface LibraryMove {
  hash: string;
  oldPhoto: StoredPhoto;
  oldRoot: string;
  stat: fs.Stats;
}

export interface LibraryMovePlan {
  moves: Map<string, LibraryMove>;
  unresolved: Set<string>;
}

function hashCandidates(db: LibraryDb, size: number) {
  return db
    .select()
    .from(photos)
    .where(
      and(
        eq(photos.sourceSize, size),
        eq(photos.sourceHashVersion, FULL_FILE_HASH_VERSION),
        eq(photos.sourceHashFileRevision, photos.fileRevision),
        isNotNull(photos.sourceHash),
        isNull(photos.deletedAt)
      )
    )
    .all();
}

async function collectNewLibraryPaths(
  db: LibraryDb,
  files: readonly string[],
  isCurrent: () => boolean
): Promise<Map<string, string>> {
  const newPaths = new Map<string, string>();
  for (let offset = 0; offset < files.length && isCurrent(); offset += 200) {
    const batch = files.slice(offset, offset + 200);
    const known = db
      .select({ path: photos.path })
      .from(photos)
      .where(libraryPhotoPathsIn(batch))
      .all();
    const keys = new Set(known.map((row) => importPathKey(row.path)));
    for (const file of batch) {
      const key = importPathKey(file);
      if (!keys.has(key)) {
        newPaths.set(key, file);
      }
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return newPaths;
}

function resolveMoveGroups(
  plan: LibraryMovePlan,
  groups: Map<string, { matches: LibraryMove[]; targets: string[] }>
): void {
  for (const { matches, targets } of groups.values()) {
    if (targets.length === 1 && matches.length === 1) {
      plan.moves.set(targets[0], matches[0]);
    } else {
      for (const target of targets) {
        plan.unresolved.add(target);
      }
    }
  }
}

export async function planLibraryMoves(
  db: LibraryDb,
  files: readonly string[],
  isCurrent: () => boolean
): Promise<LibraryMovePlan> {
  const plan: LibraryMovePlan = { moves: new Map(), unresolved: new Set() };
  if (
    !(
      isCurrent() &&
      files.length &&
      db
        .select({ id: photos.id })
        .from(photos)
        .where(eq(photos.sourceHashVersion, FULL_FILE_HASH_VERSION))
        .limit(1)
        .get()
    )
  ) {
    return plan;
  }
  const roots = getLibraryRootPaths(db);
  const groups = new Map<
    string,
    { matches: LibraryMove[]; targets: string[] }
  >();
  const bySize = new Map<number, Promise<StoredPhoto[]>>();
  const knownPaths = new Set(files.map(importPathKey));
  const verifiedOldPhotos = (size: number): Promise<StoredPhoto[]> => {
    let pending = bySize.get(size);
    if (!pending) {
      pending = (async () => {
        const result: StoredPhoto[] = [];
        for (const old of hashCandidates(db, size)) {
          if (!isCurrent()) {
            break;
          }
          if (knownPaths.has(importPathKey(old.path))) {
            continue;
          }
          const oldRoot = libraryRootForPhoto(roots, old.path);
          if (
            (await inspectLibraryPath(old.path, oldRoot)).status === "missing"
          ) {
            result.push(old);
          }
        }
        return result;
      })();
      bySize.set(size, pending);
    }
    return pending;
  };
  const newPaths = await collectNewLibraryPaths(db, files, isCurrent);
  for (const [key, file] of newPaths) {
    if (!isCurrent()) {
      break;
    }
    const stat = await readStat(file);
    if (
      !stat ||
      db
        .select({ id: photos.id })
        .from(photos)
        .where(libraryPhotoPathEquals(file))
        .get()
    ) {
      continue;
    }
    const candidates = await verifiedOldPhotos(stat.size);
    if (!candidates.length) {
      continue;
    }
    const hash = await hashLibraryFile(file, 2);
    const after = await readStat(file);
    if (!(hash && after && sameStat(stat, after))) {
      // A changing or inaccessible target must be reconsidered by a later scan.
      plan.unresolved.add(importPathKey(file));
      continue;
    }
    const matches = candidates.filter((old) => old.sourceHash === hash);
    if (matches.length === 0) {
      continue;
    }
    const group = groups.get(hash) ?? { matches: [], targets: [] };
    group.targets.push(key);
    group.matches.push(
      ...matches.map((oldPhoto) => ({
        hash,
        oldPhoto,
        oldRoot: libraryRootForPhoto(roots, oldPhoto.path),
        stat: after,
      }))
    );
    groups.set(hash, group);
  }
  resolveMoveGroups(plan, groups);
  return plan;
}

async function collectReachableMoveFiles(
  roots: string[],
  include: (filePath: string) => boolean,
  isCurrent: () => boolean
): Promise<string[]> {
  const files: string[] = [];
  const pending = [...roots];
  while (pending.length && isCurrent()) {
    const directory = pending.pop();
    if (!directory) {
      continue;
    }
    const entries = await fs.promises.readdir(directory, {
      withFileTypes: true,
    });
    for (const entry of entries) {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(filePath);
      } else if (entry.isFile() && include(filePath)) {
        files.push(filePath);
      }
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return files;
}

/** A single delivered event cannot prove that another destination is absent. */
export async function planWatchedLibraryMoves(
  db: LibraryDb,
  files: readonly string[],
  isCurrent: () => boolean,
  include: (filePath: string) => boolean
): Promise<LibraryMovePlan> {
  const preliminary = await planLibraryMoves(db, files, isCurrent);
  if (!(preliminary.moves.size && isCurrent())) {
    return preliminary;
  }
  try {
    const allFiles = await collectReachableMoveFiles(
      getLibraryRootPaths(db),
      include,
      isCurrent
    );
    return await planLibraryMoves(db, allFiles, isCurrent);
  } catch (error) {
    log.warn({ error }, "Move destination check incomplete");
    return { moves: new Map(), unresolved: new Set(files.map(importPathKey)) };
  }
}

export async function commitLibraryMove(
  db: LibraryDb,
  move: LibraryMove,
  filePath: string,
  folderId: number | null,
  isCurrent: () => boolean
): Promise<number | null> {
  const { oldPhoto, hash, oldRoot } = move;
  const checkedAt = Date.now();
  if (
    !isCurrent() ||
    (await inspectLibraryPath(oldPhoto.path, oldRoot)).status !== "missing"
  ) {
    return null;
  }
  const stat = await readStat(filePath);
  if (!(isCurrent() && stat && sameStat(move.stat, stat))) {
    return null;
  }
  const movedId = db.transaction(() => {
    if (
      db
        .select({ id: photos.id })
        .from(photos)
        .where(libraryPhotoPathEquals(filePath))
        .get()
    ) {
      return null;
    }
    const updated = db
      .update(photos)
      .set({
        path: filePath,
        filename: path.basename(filePath),
        folderId,
        sourceStatus: "available",
        sourceCheckedAt: checkedAt,
        sourceAvailableAt: checkedAt,
        sourceMissingAt: null,
        sourceErrorCode: null,
        sourceSize: stat.size,
        sourceMtimeMs: stat.mtimeMs,
        sourceCtimeMs: stat.ctimeMs,
        sourceHashFileRevision: oldPhoto.fileRevision + 1,
        fileRevision: oldPhoto.fileRevision + 1,
      })
      .where(
        and(
          eq(photos.id, oldPhoto.id),
          eq(photos.path, oldPhoto.path),
          eq(photos.fileRevision, oldPhoto.fileRevision),
          eq(photos.sourceHash, hash),
          isNull(photos.deletedAt)
        )
      )
      .returning({ id: photos.id })
      .get();
    if (!updated) {
      return null;
    }
    for (const id of new Set([oldPhoto.folderId, folderId])) {
      if (id !== null) {
        db.update(folders)
          .set({
            photoCount: sql`(SELECT count(*) FROM photos WHERE folder_id = ${id} AND deleted_at IS NULL)`,
          })
          .where(eq(folders.id, id))
          .run();
      }
    }
    return updated.id;
  });
  if (movedId !== null) {
    invalidateFoldersCache();
    log.info(
      { photoId: movedId, reason: "unique-full-hash" },
      "Associated moved photo"
    );
  }
  return movedId;
}

let backfillTimer: ReturnType<typeof setTimeout> | undefined;
let backfillRun: Promise<void> | undefined;
let backfillGeneration = 0;
let wakeBackfill: (() => void) | undefined;

export function requestLibraryHashBackfill(): void {
  wakeBackfill?.();
}

export async function backfillLibraryFingerprint(
  db: LibraryDb,
  photo: StoredPhoto,
  isCurrent: () => boolean
): Promise<void> {
  const before = await readStat(photo.path);
  if (
    !(
      isCurrent() &&
      before &&
      before.size === photo.sourceSize &&
      before.mtimeMs === photo.sourceMtimeMs &&
      before.ctimeMs === photo.sourceCtimeMs
    )
  ) {
    return;
  }
  const hash = await hashLibraryFile(photo.path, 0);
  const after = await readStat(photo.path);
  if (isCurrent() && hash && after && sameStat(before, after)) {
    db.update(photos)
      .set({
        sourceHash: hash,
        sourceHashVersion: FULL_FILE_HASH_VERSION,
        sourceHashFileRevision: photo.fileRevision,
      })
      .where(
        and(
          eq(photos.id, photo.id),
          eq(photos.path, photo.path),
          eq(photos.fileRevision, photo.fileRevision),
          eq(photos.sourceStatus, "available"),
          isNull(photos.deletedAt)
        )
      )
      .run();
  }
}

export function startLibraryHashBackfill(isBusy: () => boolean): void {
  const generation = ++backfillGeneration;
  let cursor = 0;
  let running = false;
  let requested = false;
  const isCurrent = () => generation === backfillGeneration;
  const schedule = (delay: number) => {
    if (isCurrent()) {
      clearTimeout(backfillTimer);
      backfillTimer = setTimeout(run, delay);
      backfillTimer.unref?.();
    }
  };
  const run = () => {
    if (!isCurrent()) {
      return;
    }
    if (isBusy()) {
      schedule(1000);
      return;
    }
    requested = false;
    const db = getDatabase();
    const batch = db
      .select()
      .from(photos)
      .where(
        and(
          gt(photos.id, cursor),
          eq(photos.sourceStatus, "available"),
          isNull(photos.deletedAt),
          or(
            isNull(photos.sourceHashFileRevision),
            ne(photos.sourceHashFileRevision, photos.fileRevision)
          )
        )
      )
      .orderBy(photos.id)
      .limit(8)
      .all();
    if (batch.length === 0) {
      cursor = 0;
      schedule(60_000);
      return;
    }
    running = true;
    backfillRun = (async () => {
      for (const photo of batch) {
        if (!isCurrent() || isBusy()) {
          break;
        }
        await backfillLibraryFingerprint(db, photo, isCurrent);
        cursor = photo.id;
      }
    })()
      .catch((error: unknown) => {
        log.warn({ error }, "Library fingerprint backfill failed");
      })
      .finally(() => {
        running = false;
        if (requested) {
          cursor = 0;
        }
        schedule(100);
      });
  };
  wakeBackfill = () => {
    requested = true;
    if (!running) {
      cursor = 0;
      schedule(0);
    }
  };
  schedule(500);
}

export async function stopLibraryHashBackfill(): Promise<void> {
  backfillGeneration++;
  wakeBackfill = undefined;
  clearTimeout(backfillTimer);
  await backfillRun;
  backfillRun = undefined;
}
