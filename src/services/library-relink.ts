import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { and, count, eq, isNull } from "drizzle-orm";
import { getDatabase } from "@/db";
import { folders, photos } from "@/db/schema";
import { invalidateFoldersCache } from "@/utils/folder-paths";
import { registerGalleryCleanup } from "@/utils/gallery-lifecycle";
import { containsLibraryPath } from "@/utils/library-roots";
import { registerExplicitPhotoFolder } from "./explicit-library-folders";
import { FULL_FILE_HASH_VERSION } from "./file-hash";
import { reloadFolderMatcher } from "./folder-matcher";
import { isImportQueueBusy } from "./import-queue";
import {
  getSupportedExtensions,
  isIndexing,
  unwatchFolder,
  watchFolder,
} from "./indexer";
import { notifyLibraryChange } from "./library-change";
import {
  invalidateLibraryPhotoContent,
  wakeLibraryContentRefresh,
} from "./library-content-refresh";
import { hashLibraryFile, libraryPhotoPathEquals } from "./library-moves";
import {
  getLibraryRootPaths,
  inspectLibraryPath,
  libraryPathCondition,
  libraryRootForPhoto,
  withLibrarySourcesPaused,
} from "./library-source";
import { resolveProjectRelativePath } from "./shooting-project-files";
import { preserveRelinkThumbnail } from "./thumbnailer";

type Db = ReturnType<typeof getDatabase>;
type Photo = typeof photos.$inferSelect;
type Folder = typeof folders.$inferSelect;
type RelinkStatus =
  | "matched"
  | "unverified"
  | "missing"
  | "mismatch"
  | "conflict"
  | "inaccessible";

const EXPIRATION_MS = 600_000;
const MAX_INSPECTIONS = 12;

interface FileEvidence {
  ctimeMs: number;
  hash: string;
  mtimeMs: number;
  size: number;
}

interface Candidate {
  evidence?: FileEvidence;
  newPath: string;
  photo: Photo;
  status: RelinkStatus;
}

interface Inspection {
  candidates: Candidate[];
  db: Db;
  expiresAt: number;
  folder?: { root: Folder; descendants: Folder[]; newPath: string };
}

const inspections = new Map<string, Inspection>();
let applying = false;
registerGalleryCleanup(() => inspections.clear());

function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

export function currentLibraryHash(
  photo: Pick<
    Photo,
    | "sourceHash"
    | "sourceHashVersion"
    | "sourceHashFileRevision"
    | "fileRevision"
  >
): string | null {
  return photo.sourceHashVersion === FULL_FILE_HASH_VERSION &&
    photo.sourceHashFileRevision === photo.fileRevision
    ? photo.sourceHash
    : null;
}

export async function readLibraryFileEvidence(
  filePath: string
): Promise<FileEvidence | null> {
  const before = await fs.lstat(filePath);
  if (!before.isFile() || before.isSymbolicLink()) {
    return null;
  }
  const hash = await hashLibraryFile(filePath);
  const after = await fs.lstat(filePath);
  if (
    !(hash && after.isFile()) ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs
  ) {
    return null;
  }
  return {
    hash,
    size: after.size,
    mtimeMs: after.mtimeMs,
    ctimeMs: after.ctimeMs,
  };
}

function targetOwner(db: Db, target: string): number | undefined {
  return db
    .select({ id: photos.id })
    .from(photos)
    .where(libraryPhotoPathEquals(target))
    .get()?.id;
}

async function inspectCandidate(
  db: Db,
  roots: readonly string[],
  photo: Photo,
  newPath: string,
  targetRoot: string
): Promise<Candidate> {
  const base = { photo, newPath };
  const owner = targetOwner(db, newPath);
  if (owner !== undefined && owner !== photo.id) {
    return { ...base, status: "conflict" };
  }
  const old = await inspectLibraryPath(
    photo.path,
    libraryRootForPhoto(roots, photo.path)
  );
  if (old.status === "available") {
    return { ...base, status: "conflict" };
  }
  if (old.status === "inaccessible") {
    return { ...base, status: "inaccessible" };
  }
  try {
    await resolveProjectRelativePath(
      targetRoot,
      path.relative(targetRoot, newPath)
    );
    const evidence = await readLibraryFileEvidence(newPath);
    if (!evidence) {
      return { ...base, status: "inaccessible" };
    }
    const expectedHash = currentLibraryHash(photo);
    const expectedSize = photo.sourceSize ?? photo.fileSize;
    if (
      (expectedSize !== null && expectedSize !== evidence.size) ||
      (expectedHash !== null && expectedHash !== evidence.hash)
    ) {
      return { ...base, status: "mismatch" };
    }
    return {
      ...base,
      evidence,
      status: expectedHash ? "matched" : "unverified",
    };
  } catch (error) {
    return {
      ...base,
      status:
        code(error) === "ENOENT" || code(error) === "ENOTDIR"
          ? "missing"
          : "inaccessible",
    };
  }
}

function canApplyInspection({ candidates, folder }: Inspection): boolean {
  return (
    candidates.some(
      ({ status }) => status === "matched" || status === "unverified"
    ) &&
    candidates.every(
      ({ status }) =>
        status === "matched" ||
        status === "unverified" ||
        (folder && status === "missing")
    )
  );
}

function rememberInspection(inspection: Inspection) {
  for (const [key, stored] of inspections) {
    if (stored.expiresAt <= Date.now() || stored.db !== inspection.db) {
      inspections.delete(key);
    }
  }
  if (inspections.size >= MAX_INSPECTIONS) {
    const oldest = inspections.keys().next().value;
    if (oldest) {
      inspections.delete(oldest);
    }
  }
  const token = randomUUID();
  inspections.set(token, inspection);
  return inspectionPage(token, inspection, 0);
}

function inspectionPage(token: string, inspection: Inspection, offset: number) {
  return {
    token,
    items: inspection.candidates
      .slice(offset, offset + 100)
      .map(({ photo, newPath, status }) => ({
        photoId: photo.id,
        oldPath: photo.path,
        newPath,
        status,
      })),
    total: inspection.candidates.length,
    canApply: canApplyInspection(inspection),
    unverifiedPhotoIds: inspection.candidates
      .filter(({ status }) => status === "unverified")
      .map(({ photo }) => photo.id),
    counts: Object.fromEntries(
      (
        [
          "matched",
          "unverified",
          "missing",
          "mismatch",
          "conflict",
          "inaccessible",
        ] as const
      ).map((status) => [
        status,
        inspection.candidates.filter((candidate) => candidate.status === status)
          .length,
      ])
    ),
  };
}

function currentInspection(token: string): Inspection {
  const inspection = inspections.get(token);
  if (
    !inspection ||
    inspection.db !== getDatabase() ||
    inspection.expiresAt <= Date.now()
  ) {
    inspections.delete(token);
    throw new Error("RELINK_EXPIRED");
  }
  return inspection;
}

export function getRelinkInspection(token: string, offset: number) {
  return inspectionPage(token, currentInspection(token), offset);
}

export async function inspectPhotoRelink(
  photoId: number,
  selectedPath: string
) {
  const db = getDatabase();
  const photo = db
    .select()
    .from(photos)
    .where(and(eq(photos.id, photoId), isNull(photos.deletedAt)))
    .get();
  if (!photo) {
    throw new Error("RELINK_NOT_FOUND");
  }
  if (
    !getSupportedExtensions().includes(path.extname(selectedPath).toLowerCase())
  ) {
    throw new Error("RELINK_UNSUPPORTED_FILE");
  }
  const newPath = path.join(
    await fs.realpath(path.dirname(selectedPath)),
    path.basename(selectedPath)
  );
  const candidate = await inspectCandidate(
    db,
    getLibraryRootPaths(db),
    photo,
    newPath,
    path.dirname(newPath)
  );
  return rememberInspection({
    db,
    candidates: [candidate],
    expiresAt: Date.now() + EXPIRATION_MS,
  });
}

function folderConflict(db: Db, oldRoot: string, newRoot: string): boolean {
  if (
    containsLibraryPath(oldRoot, newRoot) ||
    containsLibraryPath(newRoot, oldRoot)
  ) {
    return true;
  }
  return db
    .select({ path: folders.path })
    .from(folders)
    .all()
    .some(
      (folder) =>
        !containsLibraryPath(oldRoot, folder.path) &&
        (containsLibraryPath(folder.path, newRoot) ||
          containsLibraryPath(newRoot, folder.path))
    );
}

export async function inspectFolderRelink(
  folderId: number,
  selectedPath: string
) {
  const db = getDatabase();
  const root = db.select().from(folders).where(eq(folders.id, folderId)).get();
  if (!root) {
    throw new Error("RELINK_NOT_FOUND");
  }
  const newPath = await fs.realpath(selectedPath);
  if (folderConflict(db, root.path, newPath)) {
    throw new Error("RELINK_CONFLICT");
  }
  const descendants = db
    .select()
    .from(folders)
    .where(libraryPathCondition(folders.path, root.path))
    .all();
  const records = db
    .select()
    .from(photos)
    .where(libraryPathCondition(photos.path, root.path))
    .all();
  const roots = getLibraryRootPaths(db);
  const candidates: Candidate[] = [];
  for (const photo of records) {
    candidates.push(
      await inspectCandidate(
        db,
        roots,
        photo,
        path.join(newPath, path.relative(root.path, photo.path)),
        newPath
      )
    );
  }
  return rememberInspection({
    db,
    candidates,
    folder: { root, descendants, newPath },
    expiresAt: Date.now() + EXPIRATION_MS,
  });
}

function sameEvidence(before?: FileEvidence, after?: FileEvidence): boolean {
  return (
    before?.hash === after?.hash &&
    before?.size === after?.size &&
    before?.mtimeMs === after?.mtimeMs &&
    before?.ctimeMs === after?.ctimeMs
  );
}

function ensureCurrent(db: Db, candidate: Candidate): void {
  const { photo, newPath } = candidate;
  const current = db.select().from(photos).where(eq(photos.id, photo.id)).get();
  const owner = targetOwner(db, newPath);
  if (
    !current ||
    current.path !== photo.path ||
    current.fileRevision !== photo.fileRevision ||
    current.contentRevision !== photo.contentRevision ||
    current.deletedAt !== photo.deletedAt ||
    (owner !== undefined && owner !== photo.id)
  ) {
    throw new Error("RELINK_STALE");
  }
}

function updateCandidate(
  db: Db,
  { photo, newPath, status, evidence }: Candidate,
  folderId: number | null,
  thumbnailPath?: string
): void {
  const fileRevision = photo.fileRevision + 1;
  db.update(photos)
    .set({
      path: newPath,
      filename: path.basename(newPath),
      folderId,
      fileRevision,
      ...(thumbnailPath ? { thumbnailPath } : {}),
      sourceStatus: evidence ? "available" : "missing",
      sourceCheckedAt: Date.now(),
      sourceAvailableAt: evidence ? Date.now() : photo.sourceAvailableAt,
      sourceMissingAt: evidence ? null : (photo.sourceMissingAt ?? Date.now()),
      sourceErrorCode: evidence ? null : "ENOENT",
      ...(evidence
        ? {
            sourceSize: evidence.size,
            sourceMtimeMs: evidence.mtimeMs,
            sourceCtimeMs: evidence.ctimeMs,
            sourceHash: evidence.hash,
            sourceHashVersion: FULL_FILE_HASH_VERSION,
            sourceHashFileRevision: fileRevision,
          }
        : {
            sourceHashFileRevision:
              status === "missing" && currentLibraryHash(photo)
                ? fileRevision
                : null,
          }),
      ...(status === "unverified"
        ? {
            contentRevision: photo.contentRevision + 1,
            refreshStatus: "pending" as const,
            refreshError: null,
            isAiProcessed: false,
            isFaceProcessed: false,
            faceProcessingError: null,
            thumbnailPath: null,
            vectorId: null,
            phash: null,
            contentHash: null,
            colorBucket: null,
            dominantColors: null,
            duelPreviewPath: null,
            deletionSourceHash: null,
          }
        : {}),
    })
    .where(eq(photos.id, photo.id))
    .run();
  if (status === "unverified") {
    invalidateLibraryPhotoContent(
      db,
      photo.id,
      photo.contentRevision + 1,
      photo.isFaceProcessed || photo.faceRefreshPending
    );
  }
}

function relocateFolder(
  db: Db,
  folder: NonNullable<Inspection["folder"]>,
  candidates: Candidate[]
) {
  if (folderConflict(db, folder.root.path, folder.newPath)) {
    throw new Error("RELINK_CONFLICT");
  }
  const latest = db
    .select({ id: folders.id, path: folders.path })
    .from(folders)
    .where(libraryPathCondition(folders.path, folder.root.path))
    .all();
  const latestCount =
    db
      .select({ value: count() })
      .from(photos)
      .where(libraryPathCondition(photos.path, folder.root.path))
      .get()?.value ?? 0;
  const expectedFolders = new Map(
    folder.descendants.map((entry) => [entry.id, entry.path])
  );
  if (
    latestCount !== candidates.length ||
    latest.length !== expectedFolders.size ||
    latest.some((entry) => expectedFolders.get(entry.id) !== entry.path)
  ) {
    throw new Error("RELINK_STALE");
  }
  for (const old of folder.descendants) {
    db.update(folders)
      .set({
        path: path.join(
          folder.newPath,
          path.relative(folder.root.path, old.path)
        ),
        ...(old.id === folder.root.id ? { parentId: null } : {}),
        sourceStatus: "unverified",
        isWatching: false,
        watcherStartedAt: null,
        lastScanResult: null,
      })
      .where(eq(folders.id, old.id))
      .run();
  }
}

function updateRelocatedCounts(
  db: Db,
  previous: number | null,
  next: number | null
): void {
  for (const id of new Set([previous, next])) {
    if (id !== null) {
      db.update(folders)
        .set({
          photoCount: db.$count(
            photos,
            and(eq(photos.folderId, id), isNull(photos.deletedAt))
          ),
        })
        .where(eq(folders.id, id))
        .run();
    }
  }
}

async function preserveMatchedPreviews(candidates: Candidate[]) {
  const previews = new Map<number, string>();
  for (const candidate of candidates) {
    if (candidate.status !== "matched") {
      continue;
    }
    const preview = await preserveRelinkThumbnail(
      candidate.photo.path,
      candidate.newPath,
      candidate.photo
    );
    if (preview) {
      previews.set(candidate.photo.id, preview);
    }
  }
  return previews;
}

export async function applyLibraryRelink(
  token: string,
  confirmedPhotoIds: number[]
) {
  const inspection = currentInspection(token);
  const { db, folder, candidates } = inspection;
  if (applying || (folder && (isImportQueueBusy() || isIndexing()))) {
    throw new Error("RELINK_BUSY");
  }
  const confirmed = new Set(confirmedPhotoIds);
  if (
    !canApplyInspection(inspection) ||
    candidates.some(
      (entry) => entry.status === "unverified" && !confirmed.has(entry.photo.id)
    )
  ) {
    throw new Error("RELINK_CONFIRMATION_REQUIRED");
  }
  applying = true;
  let committed = false;
  let detachedWatcher = false;
  try {
    await withLibrarySourcesPaused(
      folder
        ? [folder.root.path, folder.newPath]
        : candidates.flatMap(({ photo, newPath }) => [photo.path, newPath]),
      async () => {
        const roots = getLibraryRootPaths(db);
        const previews = await preserveMatchedPreviews(candidates);
        for (const previous of candidates) {
          const checked = await inspectCandidate(
            db,
            roots,
            previous.photo,
            previous.newPath,
            folder?.newPath ?? path.dirname(previous.newPath)
          );
          if (
            checked.status !== previous.status ||
            !sameEvidence(previous.evidence, checked.evidence)
          ) {
            throw new Error("RELINK_STALE");
          }
        }
        currentInspection(token);
        if (folder) {
          if (isImportQueueBusy() || isIndexing()) {
            throw new Error("RELINK_BUSY");
          }
          await unwatchFolder(folder.root.path);
          detachedWatcher = true;
        }
        currentInspection(token);
        db.transaction(() => {
          for (const candidate of candidates) {
            ensureCurrent(db, candidate);
          }
          if (folder) {
            relocateFolder(db, folder, candidates);
          }
          for (const candidate of candidates) {
            const nextFolder = folder
              ? candidate.photo.folderId
              : registerExplicitPhotoFolder(candidate.newPath);
            updateCandidate(
              db,
              candidate,
              nextFolder,
              previews.get(candidate.photo.id)
            );
            if (!folder) {
              updateRelocatedCounts(db, candidate.photo.folderId, nextFolder);
            }
          }
        });
        committed = true;
      }
    );
    inspections.delete(token);
    reloadFolderMatcher();
    invalidateFoldersCache();
    notifyLibraryChange(null, "update");
    wakeLibraryContentRefresh();
    return { updated: candidates.length };
  } finally {
    applying = false;
    if (
      folder &&
      detachedWatcher &&
      !folder.root.explicitOnly &&
      db === getDatabase()
    ) {
      watchFolder(
        committed ? folder.newPath : folder.root.path,
        notifyLibraryChange
      );
    }
  }
}
