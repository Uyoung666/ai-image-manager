import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import sharp from "sharp";
import { getDatabase } from "@/db";
import { shootingProjectPhotos, shootingProjects } from "@/db/schema";
import { PrioritySemaphore } from "@/utils/priority-semaphore";
import { resolveHeifInput } from "./heif-input";
import {
  applyExifOrientation,
  getOrientedDimensions,
  resolveImageOrientation,
} from "./image-orientation";
import { computePHash } from "./perceptual-hash";
import { parseProjectExif } from "./project-exif";
import {
  extractRawPreview,
  isRawFile,
  RAW_EXTENSIONS,
  readRawDimensions,
} from "./raw-preview";
import {
  getLightweightFingerprint,
  hashProjectFile,
  projectPreviewPath,
  removeProjectPreviewTemporary,
  resolveProjectRelativePath,
  ShootingProjectError,
  validateProjectPreviewLocation,
} from "./shooting-project-files";

const SUPPORTED_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".avif",
  ".tiff",
  ".tif",
  ".heic",
  ".heif",
  ".gif",
  ".bmp",
  ".ico",
  ...RAW_EXTENSIONS,
]);
const slots = new PrioritySemaphore(2);
type ProjectPhotoRow = typeof shootingProjectPhotos.$inferSelect;
interface Runtime {
  controller: AbortController;
  previews: Map<
    string,
    { controller: AbortController; promise: Promise<void> }
  >;
  scan?: Promise<void>;
  verification?: Promise<void>;
}
const runtimes = new Map<string, Runtime>();
let stopped = false;

function projectRow(projectId: string) {
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

function runtimeFor(projectId: string): Runtime {
  let runtime = runtimes.get(projectId);
  if (!runtime) {
    runtime = { controller: new AbortController(), previews: new Map() };
    runtimes.set(projectId, runtime);
  }
  return runtime;
}

function checkCancelled(runtime: Runtime) {
  if (runtime.controller.signal.aborted || stopped) {
    throw new DOMException("Cancelled", "AbortError");
  }
}

function failureCode(error: unknown): string {
  return error instanceof ShootingProjectError
    ? error.code
    : ((error as NodeJS.ErrnoException)?.code ?? "READ_FAILED");
}

export async function verifyProjectPhoto(
  row: ProjectPhotoRow,
  sourceRoot: string
): Promise<
  "available" | "missing" | "inaccessible" | "changed" | "unverified"
> {
  try {
    const source = await resolveProjectRelativePath(
      sourceRoot,
      row.relativePath
    );
    const before = await fs.stat(source);
    if (before.size !== row.fileSize) {
      return "changed";
    }
    if (row.contentHash) {
      if ((await hashProjectFile(source)) !== row.contentHash) {
        return "changed";
      }
    } else if (row.lightweightFingerprint) {
      if (
        (await getLightweightFingerprint(source)) !== row.lightweightFingerprint
      ) {
        return "changed";
      }
    } else {
      return "unverified";
    }
    const after = await fs.stat(source);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      return "changed";
    }
    // A changed timestamp is evidence requiring an explicit root association.
    return before.mtimeMs === row.modifiedAt ? "available" : "changed";
  } catch (error) {
    const code = failureCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") {
      return "missing";
    }
    return code === "SOURCE_CHANGED" || code === "INVALID_SOURCE"
      ? "changed"
      : "inaccessible";
  }
}

async function ensurePreviewDirectory(projectId: string) {
  return await validateProjectPreviewLocation(projectId, true);
}

async function renderProjectPreview(source: string, runtime: Runtime) {
  // Buffer inputs prevent libvips' file cache from retaining removable-media
  // handles after a preview job has completed on Windows.
  const input = isRawFile(source)
    ? await extractRawPreview(source)
    : await fs.readFile(source);
  if (!input) {
    throw new ShootingProjectError("PREVIEW_UNAVAILABLE");
  }
  checkCancelled(runtime);
  const decodedInput = await resolveHeifInput(input);
  checkCancelled(runtime);
  const metadata = await sharp(decodedInput, { failOn: "error" }).metadata();
  const orientation = await resolveImageOrientation(source, metadata);
  const originalDimensions = isRawFile(source)
    ? await readRawDimensions(source)
    : { width: metadata.width ?? 0, height: metadata.height ?? 0 };
  const dimensions = getOrientedDimensions(
    originalDimensions?.width,
    originalDimensions?.height,
    orientation
  );
  const buffer = await applyExifOrientation(
    sharp(decodedInput, { failOn: "error" }),
    orientation
  )
    .resize({
      width: 2560,
      height: 2560,
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({ quality: 92 })
    .toBuffer({ resolveWithObject: true });
  return { dimensions, buffer };
}

async function completeCaptureDate(
  source: string,
  photoId: string,
  runtime: Runtime
) {
  try {
    const metadata = await parseProjectExif(source);
    checkCancelled(runtime);
    getDatabase()
      .update(shootingProjectPhotos)
      .set({
        exifJson: JSON.stringify(metadata),
        ...(metadata.dateTaken === null
          ? {}
          : { dateTaken: metadata.dateTaken }),
      })
      .where(eq(shootingProjectPhotos.id, photoId))
      .run();
  } catch {
    // Missing EXIF is valid; basic file metadata remains a stable fallback.
  }
}

async function previewSourceMatches(
  source: string,
  row: ProjectPhotoRow,
  before: { size: number; mtimeMs: number }
) {
  const after = await fs.stat(source);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    return false;
  }
  if (row.contentHash) {
    return (await hashProjectFile(source)) === row.contentHash;
  }
  if (row.lightweightFingerprint) {
    return (
      (await getLightweightFingerprint(source)) === row.lightweightFingerprint
    );
  }
  return false;
}

async function buildPreview(
  projectId: string,
  photoId: string,
  runtime: Runtime
) {
  const db = getDatabase();
  const row = db
    .select()
    .from(shootingProjectPhotos)
    .where(
      and(
        eq(shootingProjectPhotos.projectId, projectId),
        eq(shootingProjectPhotos.id, photoId)
      )
    )
    .get();
  if (
    !row ||
    row.previewStatus === "ready" ||
    row.sourceStatus !== "available"
  ) {
    return;
  }
  const project = projectRow(projectId);
  const output = projectPreviewPath(projectId, photoId);
  const temporary = path.join(
    path.dirname(output),
    `${photoId}-${randomUUID()}.jpg.pending`
  );
  let ownsTemporary = false;
  try {
    checkCancelled(runtime);
    await removeProjectPreviewTemporary(
      projectId,
      photoId,
      row.previewRelativePath
    );
    checkCancelled(runtime);
    const source = await resolveProjectRelativePath(
      project.sourceRoot,
      row.relativePath
    );
    const before = await fs.stat(source);
    if (before.size !== row.fileSize || before.mtimeMs !== row.modifiedAt) {
      throw new ShootingProjectError("SOURCE_CHANGED");
    }
    const { dimensions, buffer } = await renderProjectPreview(source, runtime);
    checkCancelled(runtime);
    if (!(await previewSourceMatches(source, row, before))) {
      throw new ShootingProjectError("SOURCE_CHANGED");
    }
    await ensurePreviewDirectory(projectId);
    const handle = await fs.open(temporary, "wx");
    try {
      ownsTemporary = true;
      db.update(shootingProjectPhotos)
        .set({ previewRelativePath: path.basename(temporary) })
        .where(eq(shootingProjectPhotos.id, photoId))
        .run();
      await handle.writeFile(buffer.data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    checkCancelled(runtime);
    await fs.rename(temporary, output);
    ownsTemporary = false;
    checkCancelled(runtime);
    db.update(shootingProjectPhotos)
      .set({
        previewRelativePath: `${photoId}.jpg`,
        previewStatus: "ready",
        previewWidth: buffer.info.width,
        previewHeight: buffer.info.height,
        previewBytes: buffer.data.length,
        previewError: null,
        width: dimensions.width || null,
        height: dimensions.height || null,
      })
      .where(eq(shootingProjectPhotos.id, photoId))
      .run();
    // EXIF completion follows the first usable preview and never reorders a sequence.
    await completeCaptureDate(source, photoId, runtime);
    // Similarity is optional local image math, performed after a usable preview.
    const phash = await computePHash(buffer.data);
    checkCancelled(runtime);
    db.update(shootingProjectPhotos)
      .set({ phash })
      .where(eq(shootingProjectPhotos.id, photoId))
      .run();
  } catch (error) {
    if (!(runtime.controller.signal.aborted || stopped)) {
      db.update(shootingProjectPhotos)
        .set({
          previewStatus: "failed",
          previewError: failureCode(error),
          ...(failureCode(error) === "SOURCE_CHANGED"
            ? { sourceStatus: "changed" as const }
            : {}),
        })
        .where(eq(shootingProjectPhotos.id, photoId))
        .run();
    }
  } finally {
    // The path is a host-owned UUID JPEG staging file, never a source file.
    if (ownsTemporary) {
      await validateProjectPreviewLocation(projectId);
      await fs.unlink(temporary).catch(() => undefined);
    }
  }
}

export function queueProjectPreview(
  projectId: string,
  photoId: string,
  priority = 2
): boolean {
  if (stopped) {
    return false;
  }
  const runtime = runtimeFor(projectId);
  if (runtime.controller.signal.aborted) {
    return false;
  }
  const existing = runtime.previews.get(photoId);
  if (existing) {
    slots.promote(existing.controller.signal, priority);
    return false;
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  runtime.controller.signal.addEventListener("abort", abort, { once: true });
  const promise = (async () => {
    let acquired = false;
    try {
      await slots.acquire(controller.signal, priority);
      acquired = true;
      checkCancelled(runtime);
      await buildPreview(projectId, photoId, runtime);
    } catch {
      // Cancellation is durable pending work; opening the project can resume it.
    } finally {
      if (acquired) {
        slots.release();
      }
      runtime.controller.signal.removeEventListener("abort", abort);
      runtime.previews.delete(photoId);
    }
  })();
  runtime.previews.set(photoId, { controller, promise });
  return true;
}

async function verifyExisting(projectId: string, runtime: Runtime) {
  const project = projectRow(projectId);
  const rows = getDatabase()
    .select()
    .from(shootingProjectPhotos)
    .where(eq(shootingProjectPhotos.projectId, projectId))
    .all();
  for (const row of rows) {
    checkCancelled(runtime);
    const status = await verifyProjectPhoto(row, project.sourceRoot);
    checkCancelled(runtime);
    getDatabase()
      .update(shootingProjectPhotos)
      .set({ sourceStatus: status })
      .where(eq(shootingProjectPhotos.id, row.id))
      .run();
    if (
      status === "available" &&
      row.previewStatus !== "ready" &&
      !project.previewsCleared
    ) {
      queueProjectPreview(projectId, row.id);
    }
  }
}

interface ScanContext {
  directories: string[];
  errors: { relativePath: string; code: string }[];
  project: typeof shootingProjects.$inferSelect;
  projectId: string;
  runtime: Runtime;
  seen: Set<string>;
}

async function registerSourceFile(context: ScanContext, file: string) {
  const { projectId, project, runtime } = context;
  const db = getDatabase();
  const relativePath = path.relative(project.sourceRoot, file);
  const resolved = await resolveProjectRelativePath(
    project.sourceRoot,
    relativePath
  );
  const stat = await fs.stat(resolved);
  const existing = db
    .select()
    .from(shootingProjectPhotos)
    .where(
      and(
        eq(shootingProjectPhotos.projectId, projectId),
        eq(shootingProjectPhotos.relativePath, relativePath)
      )
    )
    .get();
  if (existing) {
    const status = await verifyProjectPhoto(existing, project.sourceRoot);
    checkCancelled(runtime);
    db.update(shootingProjectPhotos)
      .set({ sourceStatus: status })
      .where(eq(shootingProjectPhotos.id, existing.id))
      .run();
    if (
      status === "available" &&
      existing.previewStatus !== "ready" &&
      !project.previewsCleared
    ) {
      queueProjectPreview(projectId, existing.id);
    }
    return;
  }
  const fingerprint = await getLightweightFingerprint(resolved);
  const after = await fs.stat(resolved);
  if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) {
    throw new ShootingProjectError("SOURCE_CHANGED");
  }
  checkCancelled(runtime);
  const id = randomUUID();
  db.insert(shootingProjectPhotos)
    .values({
      id,
      projectId,
      relativePath,
      filename: path.basename(file),
      fileSize: stat.size,
      modifiedAt: stat.mtimeMs,
      format: path.extname(file).slice(1).toLowerCase(),
      lightweightFingerprint: fingerprint,
      sourceStatus: "available",
      createdAt: Date.now(),
    })
    .onConflictDoNothing()
    .run();
  if (!project.previewsCleared) {
    queueProjectPreview(projectId, id);
  }
}

async function discoverDirectory(context: ScanContext, directory: string) {
  checkCancelled(context.runtime);
  const entries = await fs
    .readdir(directory, { withFileTypes: true })
    .catch((error) => {
      context.errors.push({
        relativePath:
          path.relative(context.project.sourceRoot, directory) || ".",
        code: failureCode(error),
      });
      return [];
    });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    checkCancelled(context.runtime);
    if (entry.isSymbolicLink()) {
      continue;
    }
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      context.directories.push(file);
      continue;
    }
    if (
      !(
        entry.isFile() &&
        SUPPORTED_EXTENSIONS.has(path.extname(file).toLowerCase())
      )
    ) {
      continue;
    }
    const relativePath = path.relative(context.project.sourceRoot, file);
    context.seen.add(relativePath);
    try {
      await registerSourceFile(context, file);
    } catch (error) {
      if (context.runtime.controller.signal.aborted) {
        throw error;
      }
      context.errors.push({ relativePath, code: failureCode(error) });
    }
  }
}

function markUnseenProjectFiles(context: ScanContext) {
  // Never classify a subtree as missing when its enumeration failed.
  if (context.errors.length) {
    return;
  }
  const db = getDatabase();
  const existing = db
    .select({
      id: shootingProjectPhotos.id,
      relativePath: shootingProjectPhotos.relativePath,
    })
    .from(shootingProjectPhotos)
    .where(eq(shootingProjectPhotos.projectId, context.projectId))
    .all();
  for (const row of existing) {
    if (!context.seen.has(row.relativePath)) {
      db.update(shootingProjectPhotos)
        .set({ sourceStatus: "missing" })
        .where(eq(shootingProjectPhotos.id, row.id))
        .run();
    }
  }
}

async function scanProject(
  projectId: string,
  runtime: Runtime,
  incremental: boolean
) {
  const db = getDatabase();
  const project = projectRow(projectId);
  const errors: { relativePath: string; code: string }[] = [];
  const seen = new Set<string>();
  db.update(shootingProjects)
    .set({
      scanStatus: "running",
      scanKind: incremental ? "incremental" : "initial",
      scanErrorsJson: "[]",
    })
    .where(eq(shootingProjects.id, projectId))
    .run();
  const directories = [project.sourceRoot];
  const context: ScanContext = {
    projectId,
    project,
    runtime,
    directories,
    seen,
    errors,
  };
  try {
    for (const directory of directories) {
      await discoverDirectory(context, directory);
      db.update(shootingProjects)
        .set({ scanErrorsJson: JSON.stringify(errors) })
        .where(eq(shootingProjects.id, projectId))
        .run();
    }
    checkCancelled(runtime);
    markUnseenProjectFiles(context);
    db.update(shootingProjects)
      .set({
        scanStatus: errors.length ? "failed" : "completed",
        scanErrorsJson: JSON.stringify(errors),
        ...(errors.length === 0 ? { initialScanCompleted: true } : {}),
        updatedAt: Date.now(),
      })
      .where(eq(shootingProjects.id, projectId))
      .run();
  } catch (error) {
    const aborted = runtime.controller.signal.aborted || stopped;
    db.update(shootingProjects)
      .set({
        scanStatus: aborted ? "interrupted" : "failed",
        scanErrorsJson: JSON.stringify(
          aborted
            ? errors
            : [...errors, { relativePath: ".", code: failureCode(error) }]
        ),
      })
      .where(eq(shootingProjects.id, projectId))
      .run();
  }
}

export function beginProjectScan(
  projectId: string,
  incremental: boolean
): void {
  if (stopped) {
    return;
  }
  const runtime = runtimeFor(projectId);
  if (runtime.scan) {
    return;
  }
  runtime.scan = scanProject(projectId, runtime, incremental).finally(() => {
    runtime.scan = undefined;
  });
}

export function beginProjectPreparation(projectId: string): void {
  if (stopped || runtimes.has(projectId)) {
    return;
  }
  const runtime = runtimeFor(projectId);
  const project = projectRow(projectId);
  if (project.sourceStatus !== "online") {
    return;
  }
  getDatabase()
    .update(shootingProjectPhotos)
    .set({ sourceStatus: "unverified" })
    .where(eq(shootingProjectPhotos.projectId, projectId))
    .run();
  runtime.verification = verifyExisting(projectId, runtime)
    .catch(() => undefined)
    .finally(() => {
      runtime.verification = undefined;
    });
  if (!project.initialScanCompleted) {
    beginProjectScan(projectId, false);
  }
}

export async function stopProjectPreparation(projectId: string): Promise<void> {
  const runtime = runtimes.get(projectId);
  if (!runtime) {
    return;
  }
  runtime.controller.abort();
  await Promise.allSettled([
    runtime.scan,
    runtime.verification,
    ...[...runtime.previews.values()].map((item) => item.promise),
  ]);
  runtimes.delete(projectId);
}

export function startShootingProjectServices(): void {
  stopped = false;
  getDatabase()
    .update(shootingProjects)
    .set({ scanStatus: "interrupted" })
    .where(eq(shootingProjects.scanStatus, "running"))
    .run();
}

export async function stopShootingProjectServices(): Promise<void> {
  stopped = true;
  await Promise.all([...runtimes.keys()].map(stopProjectPreparation));
}

export function hasProjectPreparation(projectId: string) {
  return runtimes.has(projectId);
}
