import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { and, eq, inArray } from "drizzle-orm";
import { BrowserWindow } from "electron";
import { getDatabase } from "@/db";
import {
  shootingProjectOutputs,
  shootingProjectPhotos,
  shootingProjects,
} from "@/db/schema";
import type { ShootingProjectLibraryRequest } from "@/types/shooting-project";
import { registerGalleryCleanup } from "@/utils/gallery-lifecycle";
import {
  getLightweightFingerprint,
  hashProjectFile,
  resolveProjectRelativePath,
} from "./shooting-project-files";
import { resolveShootingProjectCompletedOutputFiles } from "./shooting-project-output";

interface LibraryFile {
  path: string;
  photoId: string;
}
interface LibraryReceipt {
  expiresAt: number;
  files: LibraryFile[];
  request: ShootingProjectLibraryRequest;
  unavailable: number;
}

export class ShootingProjectLibraryError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

const receipts = new Map<string, LibraryReceipt>();
const active = new Map<
  AbortController,
  { projectId: string; promise: Promise<{ added: number; failed: number }> }
>();
let stopping = false;
let serviceGeneration = 0;
const projectGenerations = new Map<string, number>();
registerGalleryCleanup(() => receipts.clear());

async function resolveLibraryFiles(
  request: ShootingProjectLibraryRequest
): Promise<{ files: LibraryFile[]; unavailable: number }> {
  const project = getDatabase()
    .select()
    .from(shootingProjects)
    .where(eq(shootingProjects.id, request.projectId))
    .get();
  if (!project) {
    throw new ShootingProjectLibraryError("NOT_FOUND");
  }
  if (request.source === "output") {
    return resolveOutputLibraryFiles(request);
  }
  const rows = getDatabase()
    .select()
    .from(shootingProjectPhotos)
    .where(
      and(
        eq(shootingProjectPhotos.projectId, request.projectId),
        request.photoIds
          ? inArray(shootingProjectPhotos.id, request.photoIds)
          : eq(shootingProjectPhotos.status, "kept")
      )
    )
    .all();
  const files: LibraryFile[] = [];
  let unavailable = request.photoIds
    ? new Set(request.photoIds).size - rows.length
    : 0;
  for (const row of rows) {
    try {
      if (row.sourceStatus !== "available" || !row.lightweightFingerprint) {
        throw new Error("Unverified source");
      }
      const file = await resolveProjectRelativePath(
        project.sourceRoot,
        row.relativePath
      );
      const stat = await fs.stat(file);
      if (
        !stat.isFile() ||
        stat.size !== row.fileSize ||
        stat.mtimeMs !== row.modifiedAt ||
        (await getLightweightFingerprint(file)) !==
          row.lightweightFingerprint ||
        (row.contentHash && (await hashProjectFile(file)) !== row.contentHash)
      ) {
        throw new Error("Changed source");
      }
      files.push({ photoId: row.id, path: file });
    } catch {
      unavailable++;
    }
  }
  return { files, unavailable };
}

async function resolveOutputLibraryFiles(
  request: ShootingProjectLibraryRequest
): Promise<{ files: LibraryFile[]; unavailable: number }> {
  if (!request.taskId) {
    throw new ShootingProjectLibraryError("OUTPUT_NOT_FOUND");
  }
  const files = await resolveShootingProjectCompletedOutputFiles({
    projectId: request.projectId,
    taskId: request.taskId,
  });
  const selected = request.photoIds ? new Set(request.photoIds) : null;
  const filtered = selected
    ? files.filter((file) => selected.has(file.photoId))
    : files;
  return {
    files: filtered,
    unavailable: selected
      ? selected.size - new Set(filtered.map((file) => file.photoId)).size
      : 0,
  };
}

export async function inspectShootingProjectLibrary(
  request: ShootingProjectLibraryRequest
) {
  if (stopping) {
    throw new ShootingProjectLibraryError("PROJECT_BUSY");
  }
  const generation = serviceGeneration;
  const projectGeneration = projectGenerations.get(request.projectId) ?? 0;
  const result = await resolveLibraryFiles(request);
  if (
    stopping ||
    generation !== serviceGeneration ||
    projectGeneration !== (projectGenerations.get(request.projectId) ?? 0)
  ) {
    throw new ShootingProjectLibraryError("LIBRARY_SCOPE_CHANGED");
  }
  const token = randomUUID();
  for (const [key, receipt] of receipts) {
    if (receipt.expiresAt < Date.now() || receipts.size >= 128) {
      receipts.delete(key);
    }
  }
  receipts.set(token, {
    request,
    ...result,
    expiresAt: Date.now() + 10 * 60_000,
  });
  return {
    token,
    count: result.files.length,
    unavailable: result.unavailable,
    paths: result.files.map((file) => file.path),
    photoIds: result.files.map((file) => file.photoId),
  };
}

export async function addShootingProjectToLibrary(
  input: ShootingProjectLibraryRequest & {
    inspectionToken: string;
    confirmed: true;
  }
) {
  if (stopping) {
    throw new ShootingProjectLibraryError("PROJECT_BUSY");
  }
  const generation = serviceGeneration;
  const projectGeneration = projectGenerations.get(input.projectId) ?? 0;
  const receipt = receipts.get(input.inspectionToken);
  if (
    !receipt ||
    receipt.expiresAt < Date.now() ||
    receipt.request.projectId !== input.projectId ||
    receipt.request.source !== input.source ||
    receipt.request.taskId !== input.taskId
  ) {
    throw new ShootingProjectLibraryError("LIBRARY_INSPECTION_EXPIRED");
  }
  receipts.delete(input.inspectionToken);
  if (receipt.files.length === 0) {
    throw new ShootingProjectLibraryError("LIBRARY_EMPTY");
  }
  const current = await resolveLibraryFiles({
    ...receipt.request,
    photoIds: receipt.files.map((file) => file.photoId),
  });
  if (
    stopping ||
    generation !== serviceGeneration ||
    projectGeneration !== (projectGenerations.get(input.projectId) ?? 0) ||
    current.unavailable ||
    current.files.length !== receipt.files.length ||
    current.files.some(
      (file) =>
        !receipt.files.some(
          (previous) =>
            previous.photoId === file.photoId && previous.path === file.path
        )
    )
  ) {
    throw new ShootingProjectLibraryError("LIBRARY_SCOPE_CHANGED");
  }
  const controller = new AbortController();
  const operation = (async () => {
    const { indexExplicitPhotoFiles } = await import("./indexer");
    const result = await indexExplicitPhotoFiles(
      receipt.files.map((file) => file.path),
      controller.signal,
      input.source === "output"
        ? getDatabase()
            .select({ path: shootingProjectOutputs.targetRoot })
            .from(shootingProjectOutputs)
            .where(
              and(
                eq(shootingProjectOutputs.id, input.taskId ?? ""),
                eq(shootingProjectOutputs.projectId, input.projectId)
              )
            )
            .get()?.path
        : getDatabase()
            .select({ path: shootingProjects.sourceRoot })
            .from(shootingProjects)
            .where(eq(shootingProjects.id, input.projectId))
            .get()?.path
    );
    const { invalidateCountCache } = await import(
      "@/ipc/photos/handlers/listing"
    );
    const { invalidateIndexStatsCache, invalidateStatsCache } = await import(
      "@/ipc/photos/handlers/stats"
    );
    invalidateCountCache();
    invalidateIndexStatsCache();
    invalidateStatsCache();
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send("file-change", { type: "add", photoId: null });
    }
    if (result.added && !controller.signal.aborted) {
      const { requestExplicitFileEmbedding } = await import("./import-queue");
      requestExplicitFileEmbedding();
    }
    return { added: result.added, failed: result.failed + receipt.unavailable };
  })();
  active.set(controller, { projectId: input.projectId, promise: operation });
  try {
    return await operation;
  } finally {
    active.delete(controller);
  }
}

export function startShootingProjectLibraryServices(): void {
  stopping = false;
}

export async function stopShootingProjectLibraryTasks(
  projectId?: string
): Promise<void> {
  if (projectId) {
    projectGenerations.set(
      projectId,
      (projectGenerations.get(projectId) ?? 0) + 1
    );
  } else {
    stopping = true;
    serviceGeneration++;
  }
  const promises: Promise<{ added: number; failed: number }>[] = [];
  for (const [controller, operation] of active) {
    if (!projectId || operation.projectId === projectId) {
      controller.abort();
      promises.push(operation.promise);
    }
  }
  await Promise.allSettled(promises);
  for (const [token, receipt] of receipts) {
    if (!projectId || receipt.request.projectId === projectId) {
      receipts.delete(token);
    }
  }
}
