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
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import PQueue from "p-queue";
import { getDatabase } from "@/db";
import { folders, libraryMoveCandidates, photos } from "@/db/schema";
import { invalidateFoldersCache } from "@/utils/folder-paths";
import { importPathKey } from "@/utils/import-path";
import { selectLibraryRoots } from "@/utils/library-roots";
import { createLogger } from "@/utils/logger";
import { computeFullFileHash, FULL_FILE_HASH_VERSION } from "./file-hash";
import {
  type LibraryMoveCandidate,
  rememberLibraryMoveCandidates,
} from "./library-move-candidates";
import {
  getLibraryRootPaths,
  inspectLibraryPath,
  inspectLibraryRoot,
  libraryRootForPhoto,
  librarySourceIsPaused,
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
  priority = 1,
  signal?: AbortSignal
): Promise<string | null> {
  signal?.throwIfAborted();
  return (
    (await hashQueue.add(
      () => {
        signal?.throwIfAborted();
        return computeFullFileHash(filePath, signal);
      },
      { priority }
    )) ?? null
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
  candidatesChanged: boolean;
  moves: Map<string, LibraryMove>;
  unresolved: Set<string>;
}

interface MoveTarget {
  filePath: string;
  key: string;
  stat: fs.Stats;
}

interface MoveGroup {
  matches: StoredPhoto[];
  targets: MoveTarget[];
}

interface MoveScan {
  complete: boolean;
  folderPath: string;
}

interface MoveOptions {
  include: (filePath: string) => boolean;
  scan?: MoveScan;
  skipDirectory: (folderPath: string) => boolean;
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

interface MoveObservation {
  fingerprints: Map<string, { hash: string; stat: fs.Stats }>;
  groups: Map<string, MoveGroup>;
  originals: Map<number, StoredPhoto>;
  unstable: Set<string>;
  unstableSizes: Set<number>;
}

async function observeMoveTargets(
  db: LibraryDb,
  files: readonly string[],
  isCurrent: () => boolean,
  previous?: MoveObservation
): Promise<MoveObservation> {
  const result: MoveObservation = {
    groups: new Map(),
    unstable: new Set(),
    unstableSizes: new Set(),
    originals: new Map(),
    fingerprints: new Map(),
  };
  const roots = getLibraryRootPaths(db);
  const bySize = new Map<number, Promise<StoredPhoto[]>>();
  const knownPaths = new Set(files.map(importPathKey));
  const verifiedOldPhotos = (size: number): Promise<StoredPhoto[]> => {
    let pending = bySize.get(size);
    if (!pending) {
      pending = (async () => {
        const candidates: StoredPhoto[] = [];
        for (const old of hashCandidates(db, size)) {
          if (!isCurrent()) {
            break;
          }
          if (
            knownPaths.has(importPathKey(old.path)) ||
            librarySourceIsPaused(old.path)
          ) {
            continue;
          }
          if (
            (
              await inspectLibraryPath(
                old.path,
                libraryRootForPhoto(roots, old.path)
              )
            ).status === "missing"
          ) {
            candidates.push(old);
            result.originals.set(old.id, old);
          }
        }
        return candidates;
      })();
      bySize.set(size, pending);
    }
    return pending;
  };
  const newPaths = await collectNewLibraryPaths(db, files, isCurrent);
  for (const [key, filePath] of newPaths) {
    if (!isCurrent()) {
      break;
    }
    const stat = await readStat(filePath);
    if (!stat || librarySourceIsPaused(filePath)) {
      continue;
    }
    const candidates = await verifiedOldPhotos(stat.size);
    if (!candidates.length) {
      continue;
    }
    const cached = previous?.fingerprints.get(key);
    const hash =
      cached && sameStat(cached.stat, stat)
        ? cached.hash
        : await hashLibraryFile(filePath, 2);
    const after = await readStat(filePath);
    if (!(hash && after && sameStat(stat, after))) {
      result.unstable.add(key);
      result.unstableSizes.add(stat.size);
      continue;
    }
    result.fingerprints.set(key, { hash, stat: after });
    const matches = candidates.filter((old) => old.sourceHash === hash);
    if (matches.length) {
      const group = result.groups.get(hash) ?? { matches, targets: [] };
      group.targets.push({ filePath, key, stat: after });
      result.groups.set(hash, group);
    }
  }
  return result;
}

interface ReachableFiles {
  complete: boolean;
  files: string[];
}

function collectMoveDirectoryEntries(
  entries: fs.Dirent[],
  directory: string,
  files: Map<string, string>,
  pending: string[],
  options: MoveOptions
) {
  for (const entry of entries) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory() && !options.skipDirectory(filePath)) {
      pending.push(filePath);
    } else if (entry.isFile() && options.include(filePath)) {
      files.set(importPathKey(filePath), filePath);
    }
  }
}

async function collectMoveRoot(
  rootPath: string,
  files: Map<string, string>,
  options: MoveOptions,
  isCurrent: () => boolean
): Promise<boolean> {
  let complete = true;
  const pending = [rootPath];
  const scanKey = options.scan ? importPathKey(options.scan.folderPath) : null;
  while (pending.length && isCurrent()) {
    const directory = pending.pop();
    if (!directory) {
      break;
    }
    if (importPathKey(directory) === scanKey) {
      continue;
    }
    if (librarySourceIsPaused(directory)) {
      complete = false;
      continue;
    }
    try {
      const entries = await fs.promises.readdir(directory, {
        withFileTypes: true,
      });
      collectMoveDirectoryEntries(entries, directory, files, pending, options);
    } catch (error) {
      complete = false;
      log.warn({ error, directory }, "Move destination check incomplete");
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return complete && isCurrent();
}

async function collectReachableMoveFiles(
  db: LibraryDb,
  initial: readonly string[],
  options: MoveOptions,
  isCurrent: () => boolean
): Promise<ReachableFiles> {
  const files = new Map(initial.map((file) => [importPathKey(file), file]));
  const roots = selectLibraryRoots(
    db
      .select({ path: folders.path })
      .from(folders)
      .where(eq(folders.explicitOnly, false))
      .all()
  );
  let complete = options.scan?.complete ?? true;
  for (const root of roots) {
    if (!isCurrent()) {
      return { complete: false, files: [...files.values()] };
    }
    const status = await inspectLibraryRoot(root.path);
    if (status.status === "offline") {
      continue;
    }
    if (status.status !== "available") {
      complete = false;
      continue;
    }
    const rootComplete = await collectMoveRoot(
      root.path,
      files,
      options,
      isCurrent
    );
    complete = rootComplete && complete;
  }
  return { complete: complete && isCurrent(), files: [...files.values()] };
}

function resolveObservedMoves(
  plan: LibraryMovePlan,
  observed: MoveObservation,
  complete: boolean,
  roots: string[]
) {
  const pendingCandidates = new Map<number, LibraryMoveCandidate[]>();
  for (const key of observed.unstable) {
    plan.unresolved.add(key);
  }
  for (const [hash, group] of observed.groups) {
    const verified =
      complete && !observed.unstableSizes.has(group.targets[0].stat.size);
    if (verified && group.matches.length === 1 && group.targets.length === 1) {
      const target = group.targets[0];
      const oldPhoto = group.matches[0];
      plan.moves.set(target.key, {
        hash,
        oldPhoto,
        oldRoot: libraryRootForPhoto(roots, oldPhoto.path),
        stat: target.stat,
      });
      continue;
    }
    const candidates: LibraryMoveCandidate[] = group.targets.map(
      ({ filePath }) => ({
        targetPath: filePath,
        reason: verified ? "ambiguous" : "incomplete",
      })
    );
    for (const target of group.targets) {
      plan.unresolved.add(target.key);
    }
    for (const original of group.matches) {
      pendingCandidates.set(original.id, candidates);
    }
  }
  return pendingCandidates;
}

function recordObservedCandidates(
  db: LibraryDb,
  observed: MoveObservation,
  pendingCandidates: Map<number, LibraryMoveCandidate[]>,
  complete: boolean
): boolean {
  let changed = false;
  const checkedAt = Date.now();
  for (const original of observed.originals.values()) {
    const candidates = pendingCandidates.get(original.id) ?? [];
    if (complete) {
      const keys = candidates.map((candidate) =>
        importPathKey(candidate.targetPath)
      );
      const removed = db
        .delete(libraryMoveCandidates)
        .where(
          and(
            eq(libraryMoveCandidates.photoId, original.id),
            keys.length
              ? notInArray(libraryMoveCandidates.targetPathKey, keys)
              : undefined
          )
        )
        .run().changes;
      changed ||= removed > 0;
    }
    if (candidates.length) {
      changed =
        rememberLibraryMoveCandidates(db, original, candidates, checkedAt) ||
        changed;
    }
  }
  return changed;
}

/** Resolve all observed destinations before assigning any historical identity. */
export async function planLibraryMoves(
  db: LibraryDb,
  files: readonly string[],
  isCurrent: () => boolean,
  options: MoveOptions
): Promise<LibraryMovePlan> {
  const plan: LibraryMovePlan = {
    candidatesChanged: false,
    moves: new Map(),
    unresolved: new Set(),
  };
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
  const initial = await observeMoveTargets(db, files, isCurrent);
  for (const key of initial.unstable) {
    plan.unresolved.add(key);
  }
  if (!(initial.groups.size && isCurrent())) {
    return plan;
  }
  const reachable = await collectReachableMoveFiles(
    db,
    files,
    options,
    isCurrent
  );
  const observed = await observeMoveTargets(
    db,
    reachable.files,
    isCurrent,
    initial
  );
  if (!isCurrent()) {
    return plan;
  }
  const pendingCandidates = resolveObservedMoves(
    plan,
    observed,
    reachable.complete,
    getLibraryRootPaths(db)
  );
  plan.candidatesChanged = recordObservedCandidates(
    db,
    observed,
    pendingCandidates,
    reachable.complete
  );
  return plan;
}

export function planWatchedLibraryMoves(
  db: LibraryDb,
  files: readonly string[],
  isCurrent: () => boolean,
  include: (filePath: string) => boolean,
  skipDirectory: (folderPath: string) => boolean = () => false
): Promise<LibraryMovePlan> {
  return planLibraryMoves(db, files, isCurrent, { include, skipDirectory });
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
