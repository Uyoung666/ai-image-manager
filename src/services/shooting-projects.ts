import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { and, asc, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { getDatabase } from "@/db";
import {
  folders,
  shootingProjectActions,
  shootingProjectOutputs,
  shootingProjectPhotos,
  shootingProjects,
} from "@/db/schema";
import type {
  CreateShootingProjectInput,
  ShootingProject,
  ShootingProjectBrowseState,
  ShootingProjectPhotoStatus,
  ShootingProjectRelinkInspection,
  ShootingProjectSource,
  ShootingProjectWorkspaceData,
} from "@/types/shooting-project";
import { FolderMatcher } from "./folder-matcher";
import {
  getLightweightFingerprint,
  hashProjectFile,
  ShootingProjectError as ProjectOperationError,
  projectPreviewPath,
  removeProjectPreviewFiles,
  resolveProjectRelativePath,
  validateProjectPreviewLocation,
} from "./shooting-project-files";
import {
  beginProjectPreparation,
  beginProjectScan,
  queueProjectPreview,
  startShootingProjectServices as startProjectRuntime,
  stopProjectPreparation,
  stopShootingProjectServices as stopProjectRuntime,
} from "./shooting-project-preparation";
import { checkSourceStatus } from "./shooting-project-source";

export const ShootingProjectError = ProjectOperationError;
export function startShootingProjectServices(): void {
  startProjectRuntime();
}
export async function stopShootingProjectServices(): Promise<void> {
  await stopProjectRuntime();
}

const TRAILING_SEPARATOR = /\/$/;

function normalizeSourceRoot(sourceRoot: string): string {
  if (
    !sourceRoot ||
    sourceRoot.includes("\0") ||
    !path.isAbsolute(sourceRoot)
  ) {
    throw new ShootingProjectError("INVALID_SOURCE");
  }
  return path.resolve(sourceRoot);
}

function sourceOverlapsLibrary(sourceRoot: string): boolean {
  // Use the library's exact case/separator/segment matching for a source
  // inside a managed folder, including the managed folder itself.
  const matcher = new FolderMatcher();
  if (matcher.match(path.join(sourceRoot, "__shooting_source__")) !== null) {
    return true;
  }

  // A recursive project source can also contain a managed child directory.
  // Match with the same normalized directory boundary as FolderMatcher.
  const normalized = sourceRoot
    .replace(/\\/g, "/")
    .replace(TRAILING_SEPARATOR, "")
    .toLowerCase();
  return getDatabase()
    .select({ path: folders.path })
    .from(folders)
    .all()
    .some(({ path: folderPath }) =>
      folderPath.replace(/\\/g, "/").toLowerCase().startsWith(`${normalized}/`)
    );
}

export async function inspectShootingProjectSource(
  sourceRoot: string
): Promise<ShootingProjectSource> {
  const resolved = normalizeSourceRoot(sourceRoot);
  return {
    defaultName: path.basename(resolved) || resolved,
    sourceInLibrary: sourceOverlapsLibrary(resolved),
    sourceRoot: resolved,
    sourceStatus: await checkSourceStatus(resolved),
  };
}

type ProjectRow = typeof shootingProjects.$inferSelect;

function describeProject(
  row: ProjectRow,
  source: ShootingProjectSource
): ShootingProject {
  const stats = getDatabase()
    .select({
      photoCount: sql<number>`count(*)`,
      keptCount: sql<number>`coalesce(sum(case when ${shootingProjectPhotos.status} = 'kept' then 1 else 0 end), 0)`,
      previewReadyCount: sql<number>`coalesce(sum(case when ${shootingProjectPhotos.previewStatus} = 'ready' and ${shootingProjectPhotos.previewRelativePath} is not null then 1 else 0 end), 0)`,
    })
    .from(shootingProjectPhotos)
    .where(eq(shootingProjectPhotos.projectId, row.id))
    .get();

  return {
    id: row.id,
    outputIncomplete: !!getDatabase()
      .select({ id: shootingProjectOutputs.id })
      .from(shootingProjectOutputs)
      .where(
        and(
          eq(shootingProjectOutputs.projectId, row.id),
          sql`${shootingProjectOutputs.status} != 'completed'`
        )
      )
      .limit(1)
      .get(),
    scanStatus: row.scanStatus,
    coverPhotoId:
      getDatabase()
        .select({ id: shootingProjectPhotos.id })
        .from(shootingProjectPhotos)
        .where(
          and(
            eq(shootingProjectPhotos.projectId, row.id),
            eq(shootingProjectPhotos.previewStatus, "ready")
          )
        )
        .orderBy(
          asc(shootingProjectPhotos.createdAt),
          asc(shootingProjectPhotos.id)
        )
        .get()?.id ?? null,
    name: row.name,
    workflow: row.workflow,
    pkMode: row.pkMode,
    sourceRoot: row.sourceRoot,
    sourceStatus: source.sourceStatus,
    sourceInLibrary: source.sourceInLibrary,
    sourceCheckedAt: row.sourceCheckedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastOpenedAt: row.lastOpenedAt,
    archivedAt: row.archivedAt,
    photoCount: stats?.photoCount ?? 0,
    keptCount: stats?.keptCount ?? 0,
    previewReadyCount: stats?.previewReadyCount ?? 0,
  };
}

export async function createShootingProject(
  input: CreateShootingProjectInput
): Promise<ShootingProject> {
  const source = await inspectShootingProjectSource(input.sourceRoot);
  if (source.sourceStatus !== "online") {
    throw new ShootingProjectError("SOURCE_UNAVAILABLE");
  }
  if (source.sourceInLibrary && !input.acknowledgeLibrarySource) {
    throw new ShootingProjectError("LIBRARY_CONFIRMATION_REQUIRED");
  }

  const name = input.name?.trim() || source.defaultName;
  if (
    name.length > 200 ||
    Array.from(name).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  ) {
    throw new ShootingProjectError("INVALID_NAME");
  }
  const now = Date.now();
  const row = getDatabase()
    .insert(shootingProjects)
    .values({
      id: randomUUID(),
      name,
      workflow: input.workflow ?? "curate",
      pkMode: input.pkMode ?? "standard",
      sourceRoot: source.sourceRoot,
      sourceStatus: source.sourceStatus,
      sourceCheckedAt: now,
      createdAt: now,
      updatedAt: now,
      lastOpenedAt: now,
    })
    .returning()
    .get();
  return describeProject(row, source);
}

async function refreshProjectSource(
  row: ProjectRow,
  opened: boolean
): Promise<ShootingProject> {
  const source = await inspectShootingProjectSource(row.sourceRoot);
  const now = Date.now();
  const updated = getDatabase()
    .update(shootingProjects)
    .set({
      sourceStatus: source.sourceStatus,
      sourceCheckedAt: now,
      ...(opened ? { lastOpenedAt: now } : {}),
    })
    .where(eq(shootingProjects.id, row.id))
    .returning()
    .get();
  if (!updated) {
    throw new ShootingProjectError("NOT_FOUND");
  }
  // The root being online does not verify individual files. Their identity
  // and access state must be checked separately by preparation/relinking.
  return describeProject(updated, source);
}

export async function listShootingProjects(input: {
  archived?: boolean;
  search?: string;
}): Promise<ShootingProject[]> {
  const search = input.search?.trim();
  const escapedSearch = search?.replace(/[\\%_]/g, "\\$&");
  const rows = getDatabase()
    .select()
    .from(shootingProjects)
    .where(
      and(
        input.archived
          ? isNotNull(shootingProjects.archivedAt)
          : isNull(shootingProjects.archivedAt),
        escapedSearch
          ? sql`${shootingProjects.name} like ${`%${escapedSearch}%`} escape '\\'`
          : undefined
      )
    )
    .orderBy(desc(shootingProjects.lastOpenedAt), desc(shootingProjects.id))
    .all();

  return await Promise.all(rows.map((row) => refreshProjectSource(row, false)));
}

export async function openShootingProject(
  id: string
): Promise<ShootingProject> {
  const row = getDatabase()
    .select()
    .from(shootingProjects)
    .where(eq(shootingProjects.id, id))
    .get();
  if (!row) {
    throw new ShootingProjectError("NOT_FOUND");
  }
  await stopProjectPreparation(id);
  return await refreshProjectSource(row, true);
}

function loadProject(projectId: string) {
  const row = getDatabase()
    .select()
    .from(shootingProjects)
    .where(eq(shootingProjects.id, projectId))
    .get();
  if (!row) {
    throw new ShootingProjectError("NOT_FOUND");
  }
  return row;
}

function safeJson<T>(value: string | null, fallback: T): T {
  try {
    return value ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}

function projectDescription(row: ProjectRow) {
  return describeProject(row, {
    defaultName: path.basename(row.sourceRoot),
    sourceRoot: row.sourceRoot,
    sourceStatus: row.sourceStatus,
    sourceInLibrary: sourceOverlapsLibrary(row.sourceRoot),
  });
}

function normalizedBrowse(
  row: ProjectRow,
  photos: (typeof shootingProjectPhotos.$inferSelect)[]
): ShootingProjectBrowseState {
  const fallback: ShootingProjectBrowseState = {
    currentPhotoId: null,
    orderedPhotoIds: [],
    filter: "all",
    format: "",
    sort: "time",
    view: "single",
    gridScrollTop: 0,
  };
  const saved = safeJson<ShootingProjectBrowseState>(
    row.browsingJson,
    fallback
  );
  const known = new Set(photos.map((photo) => photo.id));
  const order = [
    ...new Set(
      Array.isArray(saved.orderedPhotoIds)
        ? saved.orderedPhotoIds.filter((id) => known.has(id))
        : []
    ),
  ];
  const included = new Set(order);
  const newest = photos
    .filter((photo) => !included.has(photo.id))
    .sort(
      (left, right) =>
        (left.dateTaken ?? left.modifiedAt) -
          (right.dateTaken ?? right.modifiedAt) ||
        left.relativePath.localeCompare(right.relativePath) ||
        left.id.localeCompare(right.id)
    );
  order.push(...newest.map((photo) => photo.id));
  let currentPhotoId = order[0] ?? null;
  if (saved.currentPhotoId && known.has(saved.currentPhotoId)) {
    currentPhotoId = saved.currentPhotoId;
  }
  if (row.currentPhotoId && known.has(row.currentPhotoId)) {
    currentPhotoId = row.currentPhotoId;
  }
  return {
    ...fallback,
    ...saved,
    // Empty string is the shared "all formats" value; accept older saved state.
    format:
      typeof saved.format === "string" && saved.format !== "all"
        ? saved.format
        : "",
    currentPhotoId,
    orderedPhotoIds: order,
  };
}

export async function getShootingProjectWorkspace(
  projectId: string
): Promise<ShootingProjectWorkspaceData> {
  loadProject(projectId);
  beginProjectPreparation(projectId);
  const row = loadProject(projectId);
  const db = getDatabase();
  const photos = db
    .select()
    .from(shootingProjectPhotos)
    .where(eq(shootingProjectPhotos.projectId, projectId))
    .orderBy(
      asc(shootingProjectPhotos.createdAt),
      asc(shootingProjectPhotos.id)
    )
    .all();
  const browsing = normalizedBrowse(row, photos);
  const browsingJson = JSON.stringify(browsing);
  if (row.browsingJson !== browsingJson) {
    db.update(shootingProjects)
      .set({ browsingJson, currentPhotoId: browsing.currentPhotoId })
      .where(eq(shootingProjects.id, projectId))
      .run();
  }
  const counts = {
    pending: 0,
    undecided: 0,
    kept: 0,
    rejected: 0,
    reviewed: 0,
    decided: 0,
    allDecided: false,
  };
  for (const photo of photos) {
    counts[photo.status]++;
  }
  counts.reviewed = counts.kept + counts.undecided + counts.rejected;
  counts.decided = counts.kept + counts.rejected;
  const errors = safeJson<{ relativePath: string; code: string }[]>(
    row.scanErrorsJson,
    []
  );
  counts.allDecided =
    row.scanStatus === "completed" &&
    errors.length === 0 &&
    photos.length > 0 &&
    counts.pending === 0 &&
    counts.undecided === 0;
  return await Promise.resolve({
    project: projectDescription(row),
    photos: photos.map((photo) => ({
      id: photo.id,
      projectId: photo.projectId,
      relativePath: photo.relativePath,
      filename: photo.filename,
      fileSize: photo.fileSize,
      modifiedAt: photo.modifiedAt,
      dateTaken: photo.dateTaken,
      format: photo.format,
      width: photo.width,
      height: photo.height,
      status: photo.status,
      sourceStatus: photo.sourceStatus,
      previewStatus: photo.previewStatus,
      previewWidth: photo.previewWidth,
      previewHeight: photo.previewHeight,
      previewError: photo.previewError,
    })),
    browsing,
    scan: {
      status: row.scanStatus,
      kind: row.scanKind,
      discovered: photos.length,
      errors,
    },
    counts,
    previewBytes: photos.reduce(
      (total, photo) => total + photo.previewBytes,
      0
    ),
    canUndo: !!db
      .select({ id: shootingProjectActions.id })
      .from(shootingProjectActions)
      .where(eq(shootingProjectActions.projectId, projectId))
      .limit(1)
      .get(),
  });
}

export async function prepareShootingProject(input: {
  projectId: string;
  checkNew?: boolean;
  retryPreviews?: boolean;
}): Promise<ShootingProjectWorkspaceData> {
  const row = loadProject(input.projectId);
  await stopProjectPreparation(input.projectId);
  const refreshed = await refreshProjectSource(row, false);
  if (refreshed.sourceStatus !== "online") {
    throw new ShootingProjectError("SOURCE_UNAVAILABLE");
  }
  const db = getDatabase();
  if (input.retryPreviews) {
    db.update(shootingProjects)
      .set({ previewsCleared: false })
      .where(eq(shootingProjects.id, input.projectId))
      .run();
    db.update(shootingProjectPhotos)
      .set({ previewStatus: "pending", previewError: null })
      .where(
        and(
          eq(shootingProjectPhotos.projectId, input.projectId),
          eq(shootingProjectPhotos.previewStatus, "failed")
        )
      )
      .run();
  }
  beginProjectPreparation(input.projectId);
  if (input.checkNew) {
    beginProjectScan(input.projectId, row.initialScanCompleted);
  }
  return await getShootingProjectWorkspace(input.projectId);
}

export async function prioritizeShootingProjectPreviews(input: {
  projectId: string;
  photoIds: string[];
}): Promise<{ queued: number }> {
  loadProject(input.projectId);
  let queued = 0;
  const ids = [...new Set(input.photoIds)];
  for (const id of ids) {
    const row = getDatabase()
      .select()
      .from(shootingProjectPhotos)
      .where(
        and(
          eq(shootingProjectPhotos.projectId, input.projectId),
          eq(shootingProjectPhotos.id, id)
        )
      )
      .get();
    if (
      row &&
      row.previewStatus !== "ready" &&
      row.sourceStatus === "available" &&
      queueProjectPreview(input.projectId, id, 0)
    ) {
      queued++;
    }
  }
  return await Promise.resolve({ queued });
}

export async function setShootingProjectSelection(input: {
  projectId: string;
  photoIds: string[];
  status: ShootingProjectPhotoStatus;
}): Promise<ShootingProjectWorkspaceData> {
  loadProject(input.projectId);
  const ids = [...new Set(input.photoIds)];
  if (
    !(
      ids.length &&
      ["pending", "undecided", "kept", "rejected"].includes(input.status)
    )
  ) {
    throw new ShootingProjectError("INVALID_PHOTO");
  }
  const db = getDatabase();
  db.transaction(() => {
    const changes: {
      photoId: string;
      before: ShootingProjectPhotoStatus;
      after: ShootingProjectPhotoStatus;
    }[] = [];
    for (const photoId of ids) {
      const photo = db
        .select()
        .from(shootingProjectPhotos)
        .where(
          and(
            eq(shootingProjectPhotos.projectId, input.projectId),
            eq(shootingProjectPhotos.id, photoId)
          )
        )
        .get();
      if (!photo) {
        throw new ShootingProjectError("INVALID_PHOTO");
      }
      if (photo.status !== input.status) {
        changes.push({ photoId, before: photo.status, after: input.status });
        db.update(shootingProjectPhotos)
          .set({ status: input.status })
          .where(eq(shootingProjectPhotos.id, photoId))
          .run();
      }
    }
    if (changes.length) {
      db.insert(shootingProjectActions)
        .values({
          projectId: input.projectId,
          payload: JSON.stringify(changes),
          createdAt: Date.now(),
        })
        .run();
      db.update(shootingProjects)
        .set({ updatedAt: Date.now() })
        .where(eq(shootingProjects.id, input.projectId))
        .run();
    }
  });
  return await getShootingProjectWorkspace(input.projectId);
}

export async function undoShootingProjectSelection(
  projectId: string
): Promise<ShootingProjectWorkspaceData> {
  loadProject(projectId);
  const db = getDatabase();
  db.transaction(() => {
    const log = db
      .select()
      .from(shootingProjectActions)
      .where(eq(shootingProjectActions.projectId, projectId))
      .orderBy(desc(shootingProjectActions.id))
      .get();
    if (!log) {
      return;
    }
    const changes = JSON.parse(log.payload) as {
      photoId: string;
      before: ShootingProjectPhotoStatus;
      after: ShootingProjectPhotoStatus;
    }[];
    for (const change of changes) {
      db.update(shootingProjectPhotos)
        .set({ status: change.before })
        .where(
          and(
            eq(shootingProjectPhotos.projectId, projectId),
            eq(shootingProjectPhotos.id, change.photoId),
            eq(shootingProjectPhotos.status, change.after)
          )
        )
        .run();
    }
    db.delete(shootingProjectActions)
      .where(eq(shootingProjectActions.id, log.id))
      .run();
    db.update(shootingProjects)
      .set({ updatedAt: Date.now() })
      .where(eq(shootingProjects.id, projectId))
      .run();
  });
  return await getShootingProjectWorkspace(projectId);
}

export async function saveShootingProjectBrowse(input: {
  projectId: string;
  browsing: ShootingProjectBrowseState;
}): Promise<{ saved: boolean }> {
  const row = loadProject(input.projectId);
  const photos = getDatabase()
    .select()
    .from(shootingProjectPhotos)
    .where(eq(shootingProjectPhotos.projectId, input.projectId))
    .all();
  const ids = new Set(photos.map((photo) => photo.id));
  if (
    (input.browsing.currentPhotoId &&
      !ids.has(input.browsing.currentPhotoId)) ||
    input.browsing.orderedPhotoIds.some((id) => !ids.has(id))
  ) {
    throw new ShootingProjectError("INVALID_PHOTO");
  }
  const normalized = normalizedBrowse(
    {
      ...row,
      currentPhotoId: input.browsing.currentPhotoId,
      browsingJson: JSON.stringify(input.browsing),
    },
    photos
  );
  getDatabase()
    .update(shootingProjects)
    .set({
      browsingJson: JSON.stringify(normalized),
      currentPhotoId: normalized.currentPhotoId,
    })
    .where(eq(shootingProjects.id, input.projectId))
    .run();
  return await Promise.resolve({ saved: true });
}

export async function renameShootingProject(input: {
  projectId: string;
  name: string;
}): Promise<ShootingProject> {
  loadProject(input.projectId);
  const name = input.name.trim();
  if (
    !name ||
    name.length > 200 ||
    Array.from(name).some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    )
  ) {
    throw new ShootingProjectError("INVALID_NAME");
  }
  const row = getDatabase()
    .update(shootingProjects)
    .set({ name, updatedAt: Date.now() })
    .where(eq(shootingProjects.id, input.projectId))
    .returning()
    .get();
  return await Promise.resolve(projectDescription(row));
}

export async function archiveShootingProject(input: {
  projectId: string;
  archived: boolean;
}): Promise<ShootingProject> {
  loadProject(input.projectId);
  const row = getDatabase()
    .update(shootingProjects)
    .set({
      archivedAt: input.archived ? Date.now() : null,
      updatedAt: Date.now(),
    })
    .where(eq(shootingProjects.id, input.projectId))
    .returning()
    .get();
  return await Promise.resolve(projectDescription(row));
}

export async function deleteShootingProject(
  projectId: string
): Promise<{ deleted: boolean }> {
  loadProject(projectId);
  await stopProjectPreparation(projectId);
  await removeProjectPreviewFiles(
    projectId,
    getDatabase()
      .select({
        id: shootingProjectPhotos.id,
        previewRelativePath: shootingProjectPhotos.previewRelativePath,
      })
      .from(shootingProjectPhotos)
      .where(eq(shootingProjectPhotos.projectId, projectId))
      .all()
  );
  getDatabase()
    .delete(shootingProjects)
    .where(eq(shootingProjects.id, projectId))
    .run();
  return { deleted: true };
}

export async function clearShootingProjectPreviews(
  projectId: string
): Promise<ShootingProjectWorkspaceData> {
  loadProject(projectId);
  await stopProjectPreparation(projectId);
  await removeProjectPreviewFiles(
    projectId,
    getDatabase()
      .select({
        id: shootingProjectPhotos.id,
        previewRelativePath: shootingProjectPhotos.previewRelativePath,
      })
      .from(shootingProjectPhotos)
      .where(eq(shootingProjectPhotos.projectId, projectId))
      .all()
  );
  getDatabase().transaction((db) => {
    db.update(shootingProjects)
      .set({ previewsCleared: true })
      .where(eq(shootingProjects.id, projectId))
      .run();
    db.update(shootingProjectPhotos)
      .set({
        previewRelativePath: null,
        previewStatus: "pending",
        previewWidth: null,
        previewHeight: null,
        previewError: null,
        previewBytes: 0,
      })
      .where(eq(shootingProjectPhotos.projectId, projectId))
      .run();
  });
  return await getShootingProjectWorkspace(projectId);
}

export async function resolveShootingProjectPreview(
  projectId: string,
  photoId: string
): Promise<string | null> {
  const row = getDatabase()
    .select()
    .from(shootingProjectPhotos)
    .where(
      and(
        eq(shootingProjectPhotos.projectId, projectId),
        eq(shootingProjectPhotos.id, photoId)
      )
    )
    .get();
  if (!row || row.previewStatus !== "ready") {
    return null;
  }
  const file = projectPreviewPath(projectId, photoId);
  try {
    await validateProjectPreviewLocation(projectId);
    const resolved = await resolveProjectRelativePath(
      path.dirname(path.dirname(file)),
      path.join(projectId, path.basename(file))
    );
    return resolved;
  } catch {
    getDatabase()
      .update(shootingProjectPhotos)
      .set({
        previewStatus: "pending",
        previewRelativePath: null,
        previewBytes: 0,
      })
      .where(eq(shootingProjectPhotos.id, photoId))
      .run();
    return null;
  }
}

interface RelinkCandidate {
  modifiedAt: number | null;
  row: typeof shootingProjectPhotos.$inferSelect;
  status: ShootingProjectRelinkInspection["items"][number]["status"];
}
interface RelinkReceipt {
  candidates: RelinkCandidate[];
  expiresAt: number;
  previousRoot: string;
  projectId: string;
  sourceRoot: string;
}
const relinkReceipts = new Map<string, RelinkReceipt>();

async function inspectRelinkPhoto(
  row: typeof shootingProjectPhotos.$inferSelect,
  sourceRoot: string
): Promise<RelinkCandidate> {
  try {
    const source = await resolveProjectRelativePath(
      sourceRoot,
      row.relativePath
    );
    const stat = await fs.stat(source);
    const result = { row, modifiedAt: stat.mtimeMs };
    if (stat.size !== row.fileSize) {
      return { ...result, status: "changed" };
    }
    if (row.contentHash) {
      const hash = await hashProjectFile(source);
      const after = await fs.stat(source);
      return {
        ...result,
        status:
          hash === row.contentHash &&
          stat.mtimeMs === after.mtimeMs &&
          stat.size === after.size
            ? "verified"
            : "changed",
      };
    }
    if (!row.lightweightFingerprint) {
      return { ...result, status: "insufficient" };
    }
    const hash = await getLightweightFingerprint(source);
    const after = await fs.stat(source);
    return {
      ...result,
      status:
        hash === row.lightweightFingerprint &&
        stat.mtimeMs === after.mtimeMs &&
        stat.size === after.size
          ? "candidate"
          : "changed",
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    let status: RelinkCandidate["status"] = "insufficient";
    if (code === "ENOENT" || code === "ENOTDIR") {
      status = "missing";
    } else if (error instanceof ShootingProjectError) {
      status = "changed";
    }
    return {
      row,
      status,
      modifiedAt: null,
    };
  }
}

export async function inspectShootingProjectRelink(input: {
  projectId: string;
  sourceRoot: string;
}): Promise<ShootingProjectRelinkInspection> {
  const project = loadProject(input.projectId);
  const source = await inspectShootingProjectSource(input.sourceRoot);
  if (source.sourceStatus !== "online") {
    throw new ShootingProjectError("SOURCE_UNAVAILABLE");
  }
  const rows = getDatabase()
    .select()
    .from(shootingProjectPhotos)
    .where(eq(shootingProjectPhotos.projectId, input.projectId))
    .all();
  const candidates: RelinkCandidate[] = [];
  for (const row of rows) {
    candidates.push(await inspectRelinkPhoto(row, source.sourceRoot));
  }
  const token = randomUUID();
  const now = Date.now();
  for (const [id, receipt] of relinkReceipts) {
    if (receipt.expiresAt < now) {
      relinkReceipts.delete(id);
    }
  }
  // Bound abandoned inspection receipts without retaining arbitrary source data.
  if (relinkReceipts.size >= 16) {
    relinkReceipts.delete(relinkReceipts.keys().next().value as string);
  }
  relinkReceipts.set(token, {
    projectId: project.id,
    sourceRoot: source.sourceRoot,
    previousRoot: project.sourceRoot,
    expiresAt: now + 10 * 60_000,
    candidates,
  });
  return {
    token,
    sourceRoot: source.sourceRoot,
    verified: candidates.filter((item) => item.status === "verified").length,
    candidates: candidates.filter((item) => item.status === "candidate").length,
    missing: candidates.filter((item) => item.status === "missing").length,
    changed: candidates.filter((item) => item.status === "changed").length,
    insufficient: candidates.filter((item) => item.status === "insufficient")
      .length,
    items: candidates.map((item) => ({
      photoId: item.row.id,
      relativePath: item.row.relativePath,
      status: item.status,
    })),
  };
}

export async function commitShootingProjectRelink(input: {
  projectId: string;
  token: string;
  acceptCandidates: boolean;
}): Promise<ShootingProjectWorkspaceData> {
  const project = loadProject(input.projectId);
  const receipt = relinkReceipts.get(input.token);
  if (
    !receipt ||
    receipt.projectId !== input.projectId ||
    receipt.previousRoot !== project.sourceRoot ||
    receipt.expiresAt < Date.now()
  ) {
    throw new ShootingProjectError("RELINK_EXPIRED");
  }
  if (
    !input.acceptCandidates &&
    receipt.candidates.some((item) => item.status === "candidate")
  ) {
    throw new ShootingProjectError("RELINK_CONFIRMATION_REQUIRED");
  }
  await stopProjectPreparation(input.projectId);
  if (loadProject(input.projectId).sourceRoot !== receipt.previousRoot) {
    throw new ShootingProjectError("RELINK_EXPIRED");
  }
  const db = getDatabase();
  const inspectedIds = new Set(
    receipt.candidates.map((candidate) => candidate.row.id)
  );
  const assertPhotoSetMatches = () => {
    const currentIds = db
      .select({ id: shootingProjectPhotos.id })
      .from(shootingProjectPhotos)
      .where(eq(shootingProjectPhotos.projectId, input.projectId))
      .all();
    if (
      currentIds.length !== inspectedIds.size ||
      currentIds.some((photo) => !inspectedIds.has(photo.id))
    ) {
      throw new ShootingProjectError("RELINK_EXPIRED");
    }
  };
  assertPhotoSetMatches();
  const source = await inspectShootingProjectSource(receipt.sourceRoot);
  if (source.sourceStatus !== "online") {
    throw new ShootingProjectError("SOURCE_UNAVAILABLE");
  }
  const checked: RelinkCandidate[] = [];
  for (const candidate of receipt.candidates) {
    const current = getDatabase()
      .select()
      .from(shootingProjectPhotos)
      .where(
        and(
          eq(shootingProjectPhotos.projectId, input.projectId),
          eq(shootingProjectPhotos.id, candidate.row.id)
        )
      )
      .get();
    if (
      !current ||
      current.lightweightFingerprint !== candidate.row.lightweightFingerprint ||
      current.contentHash !== candidate.row.contentHash ||
      current.fileSize !== candidate.row.fileSize ||
      current.modifiedAt !== candidate.row.modifiedAt
    ) {
      throw new ShootingProjectError("RELINK_EXPIRED");
    }
    const rechecked = await inspectRelinkPhoto(current, receipt.sourceRoot);
    if (
      (candidate.status === "candidate" || candidate.status === "verified") &&
      rechecked.status !== candidate.status
    ) {
      throw new ShootingProjectError("RELINK_EXPIRED");
    }
    checked.push(rechecked);
  }
  db.transaction(() => {
    if (loadProject(input.projectId).sourceRoot !== receipt.previousRoot) {
      throw new ShootingProjectError("RELINK_EXPIRED");
    }
    // Another explicit scan may have run while candidate files were rechecked.
    assertPhotoSetMatches();
    db.update(shootingProjects)
      .set({
        sourceRoot: receipt.sourceRoot,
        sourceStatus: "online",
        sourceCheckedAt: Date.now(),
        updatedAt: Date.now(),
      })
      .where(eq(shootingProjects.id, input.projectId))
      .run();
    for (const candidate of checked) {
      const accepted =
        candidate.status === "verified" ||
        (candidate.status === "candidate" && input.acceptCandidates);
      let sourceStatus: typeof shootingProjectPhotos.$inferSelect.sourceStatus =
        "unverified";
      if (candidate.status === "missing") {
        sourceStatus = "missing";
      }
      if (candidate.status === "changed") {
        sourceStatus = "changed";
      }
      if (accepted) {
        sourceStatus = "available";
      }
      db.update(shootingProjectPhotos)
        .set({
          sourceStatus,
          ...(accepted && candidate.modifiedAt !== null
            ? { modifiedAt: candidate.modifiedAt }
            : {}),
        })
        .where(eq(shootingProjectPhotos.id, candidate.row.id))
        .run();
    }
  });
  relinkReceipts.delete(input.token);
  return await getShootingProjectWorkspace(input.projectId);
}
