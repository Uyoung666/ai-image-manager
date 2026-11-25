import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { getDatabase } from "@/db";
import {
  folders,
  shootingProjectOutputItems,
  shootingProjectOutputs,
  shootingProjectPhotos,
  shootingProjects,
} from "@/db/schema";
import type {
  ShootingProjectOutputAmbiguity,
  ShootingProjectOutputDecision,
  ShootingProjectOutputInspection,
  ShootingProjectOutputTask,
} from "@/types/shooting-project";
import { matchesManagedFolderPath } from "./folder-matcher";
import {
  getLightweightFingerprint,
  isWithinProjectRoot,
  resolveProjectRelativePath,
} from "./shooting-project-files";
import { findShootingProjectSidecars } from "./shooting-project-sidecars";

const CHUNK_BYTES = 1024 * 1024;
const UNSAFE_DIRECTORY_CHARACTERS = /[<>:"/\\|?*]/g;
const TRAILING_DIRECTORY_CHARACTERS = /[. ]+$/;
const RESERVED_DIRECTORY_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i;
const PATH_COMPONENTS = /[\\/]+/;
const ID_PATTERN = /^[a-f0-9-]{36}$/i;
const INSPECTION_TTL_MS = 10 * 60_000;
const MAX_INSPECTIONS = 128;

export class ShootingProjectOutputError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "ShootingProjectOutputError";
    this.code = code;
  }
}

type OutputRow = typeof shootingProjectOutputs.$inferSelect;
type ItemRow = typeof shootingProjectOutputItems.$inferSelect;
type ProjectRow = typeof shootingProjects.$inferSelect;
type PhotoRow = typeof shootingProjectPhotos.$inferSelect;

interface OutputInput {
  photoIds?: string[];
  projectId: string;
  targetParent: string;
}

interface CreateOutputInput extends OutputInput {
  acknowledgeWatchedTarget?: boolean;
  decisions: ShootingProjectOutputDecision[];
  inspectionToken: string;
}

interface ActiveOutput {
  controller: AbortController;
  projectId: string;
  promise: Promise<void>;
  reason: "cancel" | "shutdown";
}

interface ManifestItem {
  fileSize: number;
  kind: ItemRow["kind"];
  lightweightFingerprint: string | null;
  modifiedAt: number;
  photoId: string;
  relativePath: string;
  sourceHash: string | null;
  sourcePath: string;
  unavailable: string | null;
  versionStamp?: number[];
}

interface SidecarManifestItem extends ManifestItem {
  kind: "xmp" | "acr";
}

interface ManifestAmbiguity {
  id: string;
  items: SidecarManifestItem[];
  photos: ShootingProjectOutputAmbiguity["photos"];
}

interface OutputInspectionReceipt {
  busy: boolean;
  expiresAt: number;
  projectId: string;
  signature: string;
}

const activeOutputs = new Map<string, ActiveOutput>();
const outputInspections = new Map<string, OutputInspectionReceipt>();
const outputCommits = new Map<
  string,
  { projectId: string; promise: Promise<ShootingProjectOutputTask> }
>();
const projectGenerations = new Map<string, number>();
let serviceGeneration = 0;
let stopping = false;

function outputError(code: string): never {
  throw new ShootingProjectOutputError(code);
}

function errorCode(error: unknown): string {
  if (error instanceof ShootingProjectOutputError) {
    return error.code;
  }
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "ENOSPC" || code === "EDQUOT") {
    return "OUTPUT_NO_SPACE";
  }
  if (
    code === "EACCES" ||
    code === "EPERM" ||
    code === "EROFS" ||
    code === "EBUSY"
  ) {
    return "OUTPUT_PERMISSION_DENIED";
  }
  if (
    code === "ENOENT" ||
    code === "ENOTDIR" ||
    code === "ENODEV" ||
    code === "EIO"
  ) {
    return "OUTPUT_SOURCE_UNAVAILABLE";
  }
  if (code === "EEXIST") {
    return "OUTPUT_CONFLICT";
  }
  if (code === "ABORT_ERR" || (error as Error)?.name === "AbortError") {
    return "OUTPUT_CANCELLED";
  }
  if (code === "SOURCE_CHANGED") {
    return "OUTPUT_SOURCE_CHANGED";
  }
  return "OUTPUT_FAILED";
}

function outputGeneration(projectId: string): string {
  return `${serviceGeneration}:${projectGenerations.get(projectId) ?? 0}`;
}

function assertOutputGeneration(projectId: string, generation: string): void {
  if (stopping || generation !== outputGeneration(projectId)) {
    outputError("OUTPUT_BUSY");
  }
}

function canRecheckOutputLater(code: string): boolean {
  return (
    code === "OUTPUT_PERMISSION_DENIED" ||
    code === "OUTPUT_SOURCE_UNAVAILABLE" ||
    code === "OUTPUT_SOURCE_CHANGED"
  );
}

function assertRunning(signal: AbortSignal): void {
  if (signal.aborted) {
    outputError("OUTPUT_CANCELLED");
  }
}

function hasProtectedComponent(candidate: string): boolean {
  return candidate
    .split(PATH_COMPONENTS)
    .some((part) => part.toLowerCase() === "temp");
}

function pathKey(candidate: string): string {
  const normalized = path.resolve(candidate);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function projectRow(projectId: string): ProjectRow {
  const project = getDatabase()
    .select()
    .from(shootingProjects)
    .where(eq(shootingProjects.id, projectId))
    .get();
  if (!project) {
    outputError("OUTPUT_NOT_FOUND");
  }
  return project;
}

function taskRow(projectId: string, taskId: string): OutputRow {
  const task = getDatabase()
    .select()
    .from(shootingProjectOutputs)
    .where(
      and(
        eq(shootingProjectOutputs.id, taskId),
        eq(shootingProjectOutputs.projectId, projectId)
      )
    )
    .get();
  if (!task) {
    outputError("OUTPUT_NOT_FOUND");
  }
  return task;
}

function itemsForTask(taskId: string): ItemRow[] {
  return getDatabase()
    .select()
    .from(shootingProjectOutputItems)
    .where(eq(shootingProjectOutputItems.taskId, taskId))
    .orderBy(
      asc(shootingProjectOutputItems.relativePath),
      asc(shootingProjectOutputItems.id)
    )
    .all();
}

function describeTask(task: OutputRow): ShootingProjectOutputTask {
  const { skippedSidecars, ...details } = task;
  return {
    ...details,
    skippedSidecars: skippedSidecars ?? undefined,
    items: itemsForTask(task.id).map(
      ({
        id,
        photoId,
        relativePath,
        sourcePath,
        targetPath,
        kind,
        fileSize,
        copiedBytes,
        status,
        error,
        sha256,
      }) => ({
        id,
        photoId,
        relativePath,
        sourcePath,
        targetPath,
        kind,
        fileSize,
        copiedBytes,
        status,
        error,
        sha256,
      })
    ),
  };
}

function relativePathParts(relativePath: string): string[] {
  if (
    !relativePath ||
    path.isAbsolute(relativePath) ||
    relativePath.includes("\0")
  ) {
    outputError("OUTPUT_INVALID_TARGET");
  }
  const parts = relativePath.split(PATH_COMPONENTS);
  if (
    parts.some(
      (part) => !part || part === "." || part === ".." || part.includes(":")
    )
  ) {
    outputError("OUTPUT_INVALID_TARGET");
  }
  return parts;
}

function sourcePathFor(project: ProjectRow, photo: PhotoRow): string {
  const result = path.join(
    project.sourceRoot,
    ...relativePathParts(photo.relativePath)
  );
  if (!isWithinProjectRoot(project.sourceRoot, result)) {
    outputError("OUTPUT_INVALID_TARGET");
  }
  return result;
}

function sourceRootForItem(item: ItemRow): string {
  let root = item.sourcePath;
  for (const _part of relativePathParts(item.relativePath)) {
    root = path.dirname(root);
  }
  return root;
}

function directoryName(name: string): string {
  const cleaned = Array.from(name)
    .filter((character) => character.charCodeAt(0) >= 32)
    .join("")
    .replace(UNSAFE_DIRECTORY_CHARACTERS, "_")
    .replace(TRAILING_DIRECTORY_CHARACTERS, "")
    .slice(0, 100);
  if (!cleaned) {
    return "Shooting project";
  }
  return RESERVED_DIRECTORY_NAME.test(cleaned) ||
    cleaned.toLowerCase() === "temp"
    ? `Project-${cleaned}`
    : cleaned;
}

async function targetParent(
  project: ProjectRow,
  candidate: string
): Promise<string> {
  if (
    !candidate ||
    candidate.includes("\0") ||
    !path.isAbsolute(candidate) ||
    hasProtectedComponent(candidate)
  ) {
    outputError("OUTPUT_INVALID_TARGET");
  }
  let parent: string;
  try {
    parent = await fsp.realpath(candidate);
    if (!(await fsp.stat(parent)).isDirectory()) {
      outputError("OUTPUT_INVALID_TARGET");
    }
    await fsp.access(parent, fs.constants.W_OK);
  } catch (error) {
    if (error instanceof ShootingProjectOutputError) {
      throw error;
    }
    outputError(
      errorCode(error) === "OUTPUT_PERMISSION_DENIED"
        ? "OUTPUT_PERMISSION_DENIED"
        : "OUTPUT_INVALID_TARGET"
    );
  }
  if (hasProtectedComponent(parent)) {
    outputError("OUTPUT_INVALID_TARGET");
  }
  const source = await fsp
    .realpath(project.sourceRoot)
    .catch(() => path.resolve(project.sourceRoot));
  if (
    isWithinProjectRoot(source, parent) ||
    isWithinProjectRoot(project.sourceRoot, parent)
  ) {
    outputError("OUTPUT_TARGET_INSIDE_SOURCE");
  }
  return parent;
}

async function availableOutputDirectory(
  parent: string,
  name: string
): Promise<string> {
  const base = directoryName(name);
  for (let suffix = 1; suffix <= 10_000; suffix++) {
    const candidate = path.join(
      parent,
      suffix === 1 ? base : `${base} (${suffix})`
    );
    try {
      await fsp.lstat(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return candidate;
      }
      throw error;
    }
  }
  return outputError("OUTPUT_CONFLICT");
}

function selectedPhotos(all: PhotoRow[], photoIds?: string[]): PhotoRow[] {
  if (photoIds) {
    const selected = new Set(photoIds);
    if (selected.size === 0) {
      outputError("OUTPUT_EMPTY");
    }
    const result = all.filter((photo) => selected.has(photo.id));
    if (result.length !== selected.size) {
      outputError("OUTPUT_NOT_FOUND");
    }
    return result;
  }
  return all.filter((photo) => photo.status === "kept");
}

function sameVersion(
  stat: fs.Stats,
  version: { fileSize: number; modifiedAt: number }
): boolean {
  return (
    stat.isFile() &&
    stat.size === version.fileSize &&
    stat.mtimeMs === version.modifiedAt
  );
}

function sameOpenFile(before: fs.Stats, after: fs.Stats): boolean {
  return (
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs &&
    before.ino === after.ino &&
    before.dev === after.dev
  );
}

async function originalManifestItem(
  project: ProjectRow,
  photo: PhotoRow
): Promise<ManifestItem> {
  const item: ManifestItem = {
    photoId: photo.id,
    kind: "original",
    relativePath: photo.relativePath,
    sourcePath: sourcePathFor(project, photo),
    fileSize: photo.fileSize,
    modifiedAt: photo.modifiedAt,
    lightweightFingerprint: photo.lightweightFingerprint,
    sourceHash: photo.contentHash,
    unavailable: null,
  };
  if (photo.sourceStatus !== "available") {
    item.unavailable = "OUTPUT_SOURCE_UNAVAILABLE";
    if (photo.sourceStatus === "changed") {
      item.unavailable = "OUTPUT_SOURCE_CHANGED";
    }
    if (photo.sourceStatus === "unverified") {
      item.unavailable = "OUTPUT_UNVERIFIED";
    }
  }
  if (!(item.lightweightFingerprint || item.sourceHash)) {
    item.unavailable = "OUTPUT_UNVERIFIED";
  }
  try {
    await resolveProjectRelativePath(project.sourceRoot, photo.relativePath);
    if (!sameVersion(await fsp.stat(item.sourcePath), item)) {
      item.unavailable = "OUTPUT_SOURCE_CHANGED";
    }
  } catch (error) {
    item.unavailable = errorCode(error);
  }
  return item;
}

async function sidecarManifestItem(
  root: string,
  photoId: string,
  relativePath: string,
  kind: "xmp" | "acr",
  optional: boolean
): Promise<SidecarManifestItem> {
  const item: SidecarManifestItem = {
    photoId,
    kind,
    relativePath,
    sourcePath: path.join(root, relativePath),
    fileSize: 0,
    modifiedAt: 0,
    lightweightFingerprint: null,
    sourceHash: null,
    unavailable: null,
  };
  try {
    const sourcePath = await resolveProjectRelativePath(root, relativePath);
    const before = await fsp.stat(sourcePath);
    item.fileSize = before.size;
    item.modifiedAt = before.mtimeMs;
    item.versionStamp = [before.ctimeMs, before.ino, before.dev];
    const fingerprint = await getLightweightFingerprint(sourcePath);
    if (!sameOpenFile(before, await fsp.stat(sourcePath))) {
      outputError("OUTPUT_SOURCE_CHANGED");
    }
    item.lightweightFingerprint = fingerprint;
  } catch (error) {
    const code = errorCode(error);
    if (!(optional && canRecheckOutputLater(code))) {
      throw error;
    }
    item.unavailable = code;
  }
  return item;
}

async function buildManifest(project: ProjectRow, photoIds?: string[]) {
  const registered = getDatabase()
    .select()
    .from(shootingProjectPhotos)
    .where(eq(shootingProjectPhotos.projectId, project.id))
    .all();
  const photos = selectedPhotos(registered, photoIds).sort((a, b) =>
    a.relativePath.localeCompare(b.relativePath, "en")
  );
  if (photos.length === 0) {
    outputError("OUTPUT_EMPTY");
  }
  const originals = new Map<string, ManifestItem>();
  const directories = new Map<
    string,
    {
      relativePath: string;
      selected: ManifestItem[];
      registeredNames: string[];
    }
  >();
  for (const photo of photos) {
    const original = await originalManifestItem(project, photo);
    const key = pathKey(original.sourcePath);
    if (originals.has(key)) {
      outputError("OUTPUT_CONFLICT");
    }
    originals.set(key, original);
    const relativePath = path.dirname(photo.relativePath);
    const folderKey = pathKey(path.join(project.sourceRoot, relativePath));
    const directory = directories.get(folderKey) ?? {
      relativePath,
      selected: [],
      registeredNames: [],
    };
    directory.selected.push(original);
    directories.set(folderKey, directory);
  }
  for (const photo of registered) {
    const directory = directories.get(
      pathKey(path.join(project.sourceRoot, path.dirname(photo.relativePath)))
    );
    directory?.registeredNames.push(path.basename(photo.relativePath));
  }
  const manifest = [...originals.values()];
  const seen = new Set(originals.keys());
  const ambiguities = new Map<string, ManifestAmbiguity>();
  for (const {
    relativePath,
    selected,
    registeredNames,
  } of directories.values()) {
    const matches = await findShootingProjectSidecars(
      project.sourceRoot,
      relativePath,
      selected.map((item) => path.basename(item.relativePath)),
      registeredNames
    ).catch((error: unknown) => {
      if (
        selected.every((item) => item.unavailable) &&
        ["OUTPUT_SOURCE_UNAVAILABLE", "OUTPUT_PERMISSION_DENIED"].includes(
          errorCode(error)
        )
      ) {
        return [];
      }
      throw error;
    });
    for (const match of matches) {
      const original = originals.get(
        pathKey(path.join(project.sourceRoot, match.originalPath))
      );
      const key = pathKey(path.join(project.sourceRoot, match.relativePath));
      if (!original || seen.has(key)) {
        outputError("OUTPUT_CONFLICT");
      }
      seen.add(key);
      const item = await sidecarManifestItem(
        project.sourceRoot,
        original.photoId,
        match.relativePath,
        match.kind,
        Boolean(match.ambiguity)
      );
      if (match.ambiguity) {
        const group = ambiguities.get(match.ambiguity.id) ?? {
          ...match.ambiguity,
          items: [],
        };
        group.items.push(item);
        ambiguities.set(group.id, group);
      } else {
        manifest.push(item);
      }
    }
  }
  return { manifest, ambiguities: [...ambiguities.values()] };
}

function watchedTarget(targetRoot: string, relativePaths: string[]): boolean {
  const watched = getDatabase()
    .select({ path: folders.path })
    .from(folders)
    .where(eq(folders.isWatching, true))
    .all();
  return watched.some(
    (folder) =>
      matchesManagedFolderPath(
        path.join(targetRoot, "__output__"),
        folder.path
      ) ||
      relativePaths.some((relative) =>
        matchesManagedFolderPath(
          path.join(targetRoot, ...relativePathParts(relative)),
          folder.path
        )
      )
  );
}

function assertWatchedTargetAcknowledged(
  task: { targetRoot: string },
  relativePaths: string[],
  acknowledged?: boolean
): void {
  if (watchedTarget(task.targetRoot, relativePaths) && !acknowledged) {
    outputError("OUTPUT_WATCH_CONFIRMATION_REQUIRED");
  }
}

async function inspectOutput(input: OutputInput, assertActive: () => void) {
  try {
    const project = projectRow(input.projectId);
    const parent = await targetParent(project, input.targetParent);
    assertActive();
    const { manifest, ambiguities } = await buildManifest(
      project,
      input.photoIds
    );
    assertActive();
    const targetRoot = await availableOutputDirectory(parent, project.name);
    return { ambiguities, project, parent, manifest, targetRoot };
  } catch (error) {
    return outputError(errorCode(error));
  }
}

function inspectionSignature(
  inspected: Awaited<ReturnType<typeof inspectOutput>>
) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        inspected.project.id,
        inspected.project.sourceRoot,
        inspected.targetRoot,
        inspected.manifest,
        inspected.ambiguities,
      ])
    )
    .digest("hex");
}

export async function inspectShootingProjectOutput(
  input: OutputInput
): Promise<ShootingProjectOutputInspection> {
  if (stopping) {
    outputError("OUTPUT_BUSY");
  }
  const generation = outputGeneration(input.projectId);
  const assertActive = () =>
    assertOutputGeneration(input.projectId, generation);
  const inspected = await inspectOutput(input, assertActive);
  assertActive();
  const token = randomUUID();
  const now = Date.now();
  for (const [key, receipt] of outputInspections) {
    if (
      !receipt.busy &&
      (receipt.expiresAt <= now || outputInspections.size >= MAX_INSPECTIONS)
    ) {
      outputInspections.delete(key);
    }
  }
  if (outputInspections.size >= MAX_INSPECTIONS) {
    outputError("OUTPUT_BUSY");
  }
  outputInspections.set(token, {
    busy: false,
    expiresAt: now + INSPECTION_TTL_MS,
    projectId: input.projectId,
    signature: inspectionSignature(inspected),
  });
  const ambiguities = inspected.ambiguities.map(({ id, items, photos }) => ({
    id,
    photos,
    files: items.map(({ relativePath, kind, fileSize, unavailable }) => ({
      relativePath,
      kind,
      fileSize,
      unavailable: Boolean(unavailable),
    })),
  }));
  return {
    token,
    ambiguities,
    targetRoot: inspected.targetRoot,
    watched: watchedTarget(inspected.targetRoot, [
      ...inspected.manifest.map((item) => item.relativePath),
      ...ambiguities.flatMap((group) =>
        group.files.map((file) => file.relativePath)
      ),
    ]),
    originalCount: inspected.manifest.filter((item) => item.kind === "original")
      .length,
    xmpCount: inspected.manifest.filter((item) => item.kind === "xmp").length,
    acrCount: inspected.manifest.filter((item) => item.kind === "acr").length,
    count: inspected.manifest.length,
    unavailable: inspected.manifest.filter((item) => item.unavailable !== null)
      .length,
    bytes: inspected.manifest.reduce((total, item) => total + item.fileSize, 0),
  };
}

async function checkFreeSpace(
  parent: string,
  manifest: ManifestItem[]
): Promise<void> {
  const required =
    manifest.reduce((total, item) => total + BigInt(item.fileSize), 0n) +
    BigInt(
      manifest.reduce((maximum, item) => Math.max(maximum, item.fileSize), 0)
    );
  try {
    const space = await fsp.statfs(parent, { bigint: true });
    if (space.bavail * space.bsize < required) {
      outputError("OUTPUT_NO_SPACE");
    }
  } catch (error) {
    if (error instanceof ShootingProjectOutputError) {
      throw error;
    }
    // The actual exclusive writes still report ENOSPC on filesystems without statfs.
  }
}

function applySidecarDecisions(
  manifest: ManifestItem[],
  groups: ManifestAmbiguity[],
  decisions: ShootingProjectOutputDecision[]
) {
  const byGroup = new Map(decisions.map(({ id, action }) => [id, action]));
  if (byGroup.size !== groups.length || decisions.length !== groups.length) {
    outputError("OUTPUT_INSPECTION_CHANGED");
  }
  const skippedSidecars: string[] = [];
  const included = [...manifest];
  for (const group of groups) {
    switch (byGroup.get(group.id)) {
      case "include":
        for (const item of group.items) {
          if (item.unavailable) {
            outputError(item.unavailable);
          }
        }
        included.push(...group.items);
        break;
      case "skip":
        skippedSidecars.push(...group.items.map((item) => item.relativePath));
        break;
      default:
        outputError("OUTPUT_INSPECTION_CHANGED");
    }
  }
  return { included, skippedSidecars };
}

export async function createShootingProjectOutput(
  input: CreateOutputInput
): Promise<ShootingProjectOutputTask> {
  if (stopping) {
    outputError("OUTPUT_BUSY");
  }
  const receipt = outputInspections.get(input.inspectionToken);
  if (
    !receipt ||
    receipt.projectId !== input.projectId ||
    receipt.expiresAt <= Date.now()
  ) {
    outputError("OUTPUT_INSPECTION_EXPIRED");
  }
  if (receipt.busy) {
    outputError("OUTPUT_BUSY");
  }
  receipt.busy = true;
  try {
    return await createInspectedOutput(input, receipt);
  } finally {
    receipt.busy = false;
  }
}

function ensureInspectionActive(
  input: CreateOutputInput,
  receipt: OutputInspectionReceipt
) {
  if (stopping || outputInspections.get(input.inspectionToken) !== receipt) {
    outputError("OUTPUT_INSPECTION_EXPIRED");
  }
}

async function createInspectedOutput(
  input: CreateOutputInput,
  receipt: OutputInspectionReceipt
): Promise<ShootingProjectOutputTask> {
  const assertActive = () => ensureInspectionActive(input, receipt);
  const inspected = await inspectOutput(input, assertActive);
  assertActive();
  if (inspectionSignature(inspected) !== receipt.signature) {
    outputInspections.delete(input.inspectionToken);
    outputError("OUTPUT_INSPECTION_CHANGED");
  }
  const { included, skippedSidecars } = applySidecarDecisions(
    inspected.manifest,
    inspected.ambiguities,
    input.decisions
  );
  const relativePaths = included.map((item) => item.relativePath);
  assertWatchedTargetAcknowledged(
    inspected,
    relativePaths,
    input.acknowledgeWatchedTarget
  );
  await checkFreeSpace(inspected.parent, included);
  assertActive();
  await pinSidecarContents(inspected.project.sourceRoot, included);
  assertActive();
  const promise = commitInspectedOutput(
    input,
    receipt,
    inspected.targetRoot,
    included,
    skippedSidecars
  );
  outputCommits.set(input.inspectionToken, {
    projectId: input.projectId,
    promise,
  });
  try {
    return await promise;
  } finally {
    outputCommits.delete(input.inspectionToken);
  }
}

async function pinSidecarContents(
  root: string,
  items: ManifestItem[]
): Promise<void> {
  for (const item of items) {
    if (item.kind === "original") {
      continue;
    }
    try {
      const source = await resolveProjectRelativePath(root, item.relativePath);
      const stat = await fsp.stat(source);
      const [ctimeMs, ino, dev] = item.versionStamp ?? [];
      if (
        !(
          sameVersion(stat, item) &&
          stat.ctimeMs === ctimeMs &&
          stat.ino === ino &&
          stat.dev === dev
        )
      ) {
        outputError("OUTPUT_INSPECTION_CHANGED");
      }
      item.sourceHash = await fullHash(source);
      if (!sameOpenFile(stat, await fsp.stat(source))) {
        outputError("OUTPUT_INSPECTION_CHANGED");
      }
    } catch (error) {
      const code = errorCode(error);
      outputError(
        canRecheckOutputLater(code) ? "OUTPUT_INSPECTION_CHANGED" : code
      );
    }
  }
}

async function commitInspectedOutput(
  input: CreateOutputInput,
  receipt: OutputInspectionReceipt,
  targetRoot: string,
  included: ManifestItem[],
  skippedSidecars: string[]
): Promise<ShootingProjectOutputTask> {
  const id = randomUUID();
  try {
    await fsp.mkdir(targetRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      outputInspections.delete(input.inspectionToken);
      outputError("OUTPUT_INSPECTION_CHANGED");
    }
    return outputError(errorCode(error));
  }
  try {
    ensureInspectionActive(input, receipt);
    assertWatchedTargetAcknowledged(
      { targetRoot },
      included.map((item) => item.relativePath),
      input.acknowledgeWatchedTarget
    );
    getDatabase().transaction((db) => {
      db.insert(shootingProjectOutputs)
        .values({
          id,
          projectId: input.projectId,
          targetRoot,
          skippedSidecars: skippedSidecars.length ? skippedSidecars : null,
          status: "pending",
          createdAt: Date.now(),
        })
        .run();
      for (const item of included) {
        const itemId = randomUUID();
        const targetPath = path.join(
          targetRoot,
          ...relativePathParts(item.relativePath)
        );
        db.insert(shootingProjectOutputItems)
          .values({
            id: itemId,
            taskId: id,
            photoId: item.photoId,
            kind: item.kind,
            relativePath: item.relativePath,
            sourcePath: item.sourcePath,
            targetPath,
            tempPath: path.join(
              targetRoot,
              `.aim-output-${id}-${itemId}.partial`
            ),
            fileSize: item.fileSize,
            modifiedAt: item.modifiedAt,
            lightweightFingerprint: item.lightweightFingerprint,
            sourceHash: item.sourceHash,
            error: item.unavailable,
          })
          .run();
      }
    });
  } catch (error) {
    await fsp.rmdir(targetRoot).catch(() => undefined);
    return outputError(errorCode(error));
  }
  outputInspections.delete(input.inspectionToken);
  beginOutput(taskRow(input.projectId, id));
  return describeTask(taskRow(input.projectId, id));
}

async function assertNotLinked(candidate: string): Promise<void> {
  try {
    if ((await fsp.lstat(candidate)).isSymbolicLink()) {
      outputError("OUTPUT_INVALID_TARGET");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

async function validateTargetPaths(
  task: OutputRow,
  item: ItemRow,
  createParents: boolean
): Promise<void> {
  if (
    !(ID_PATTERN.test(task.id) && ID_PATTERN.test(item.id)) ||
    hasProtectedComponent(task.targetRoot)
  ) {
    outputError("OUTPUT_INVALID_TARGET");
  }
  const expected = path.join(
    task.targetRoot,
    ...relativePathParts(item.relativePath)
  );
  if (
    pathKey(expected) !== pathKey(item.targetPath) ||
    pathKey(
      path.join(task.targetRoot, `.aim-output-${task.id}-${item.id}.partial`)
    ) !== pathKey(item.tempPath)
  ) {
    outputError("OUTPUT_INVALID_TARGET");
  }
  const rootStat = await fsp.lstat(task.targetRoot);
  if (
    !rootStat.isDirectory() ||
    rootStat.isSymbolicLink() ||
    pathKey(await fsp.realpath(task.targetRoot)) !== pathKey(task.targetRoot)
  ) {
    outputError("OUTPUT_INVALID_TARGET");
  }
  let current = task.targetRoot;
  for (const part of relativePathParts(item.relativePath).slice(0, -1)) {
    current = path.join(current, part);
    if (createParents) {
      await fsp.mkdir(current).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") {
          throw error;
        }
      });
    }
    const stat = await fsp.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      outputError("OUTPUT_INVALID_TARGET");
    }
  }
  if (
    !isWithinProjectRoot(
      task.targetRoot,
      await fsp.realpath(path.dirname(expected))
    )
  ) {
    outputError("OUTPUT_INVALID_TARGET");
  }
  for (const candidate of [item.targetPath, item.tempPath]) {
    await assertNotLinked(candidate);
  }
}

async function removeOwnedTemporary(
  task: OutputRow,
  item: ItemRow
): Promise<void> {
  await validateTargetPaths(task, item, false);
  try {
    if (!(await fsp.lstat(item.tempPath)).isFile()) {
      outputError("OUTPUT_INVALID_TARGET");
    }
    await fsp.unlink(item.tempPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

async function fullHash(
  filePath: string,
  signal?: AbortSignal
): Promise<string> {
  const handle = await fsp.open(filePath, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile()) {
      outputError("OUTPUT_VERIFY_FAILED");
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    let position = 0;
    while (position < before.size) {
      if (signal) {
        assertRunning(signal);
      }
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, before.size - position),
        position
      );
      if (bytesRead === 0) {
        outputError("OUTPUT_VERIFY_FAILED");
      }
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    if (
      !(
        sameOpenFile(before, await handle.stat()) &&
        sameOpenFile(before, await fsp.stat(filePath))
      )
    ) {
      outputError("OUTPUT_SOURCE_CHANGED");
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

async function assertSourceVersion(item: ItemRow): Promise<string> {
  if (item.error === "OUTPUT_UNVERIFIED" && !item.sourceHash) {
    outputError("OUTPUT_UNVERIFIED");
  }
  if (!(item.lightweightFingerprint || item.sourceHash)) {
    outputError("OUTPUT_UNVERIFIED");
  }
  const source = await resolveProjectRelativePath(
    sourceRootForItem(item),
    item.relativePath
  );
  if (
    pathKey(source) !== pathKey(item.sourcePath) ||
    !sameVersion(await fsp.stat(source), item)
  ) {
    outputError("OUTPUT_SOURCE_CHANGED");
  }
  if (
    item.lightweightFingerprint &&
    (await getLightweightFingerprint(source)) !== item.lightweightFingerprint
  ) {
    outputError("OUTPUT_SOURCE_CHANGED");
  }
  return source;
}

function updateItem(
  itemId: string,
  values: Partial<typeof shootingProjectOutputItems.$inferInsert>
): void {
  getDatabase()
    .update(shootingProjectOutputItems)
    .set(values)
    .where(eq(shootingProjectOutputItems.id, itemId))
    .run();
}

function markCompleted(task: OutputRow, item: ItemRow, sha256: string): void {
  getDatabase().transaction((db) => {
    db.update(shootingProjectOutputItems)
      .set({
        status: "completed",
        copiedBytes: item.fileSize,
        sha256,
        error: null,
      })
      .where(eq(shootingProjectOutputItems.id, item.id))
      .run();
    if (item.kind === "original") {
      const photo = db
        .select()
        .from(shootingProjectPhotos)
        .where(
          and(
            eq(shootingProjectPhotos.id, item.photoId),
            eq(shootingProjectPhotos.projectId, task.projectId)
          )
        )
        .get();
      const project = db
        .select()
        .from(shootingProjects)
        .where(eq(shootingProjects.id, task.projectId))
        .get();
      if (
        photo &&
        project &&
        photo.fileSize === item.fileSize &&
        photo.modifiedAt === item.modifiedAt &&
        pathKey(sourcePathFor(project, photo)) === pathKey(item.sourcePath) &&
        (!photo.lightweightFingerprint ||
          photo.lightweightFingerprint === item.lightweightFingerprint)
      ) {
        db.update(shootingProjectPhotos)
          .set({ contentHash: sha256 })
          .where(eq(shootingProjectPhotos.id, photo.id))
          .run();
      }
    }
  });
}

async function recoverCommittedItem(
  task: OutputRow,
  item: ItemRow,
  signal: AbortSignal
): Promise<boolean> {
  if (item.status !== "completed" && item.status !== "committing") {
    return false;
  }
  if (!item.sha256) {
    outputError("OUTPUT_CONFLICT");
  }
  try {
    await fsp.lstat(item.targetPath);
  } catch (error) {
    // The process can stop after saving the commit receipt but before the
    // filesystem commit. Recopy from the pinned source, preserving its now
    // known complete digest, rather than treating an absent final file as a
    // user conflict.
    if (
      item.status === "committing" &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return false;
    }
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    outputError("OUTPUT_CONFLICT");
  }
  try {
    if ((await fullHash(item.targetPath, signal)) !== item.sha256) {
      outputError("OUTPUT_CONFLICT");
    }
  } catch (error) {
    const code = errorCode(error);
    if (code === "OUTPUT_CANCELLED" || canRecheckOutputLater(code)) {
      throw error;
    }
    outputError("OUTPUT_CONFLICT");
  }
  markCompleted(task, item, item.sha256);
  await removeOwnedTemporary(task, item);
  return true;
}

async function copyAndHash(
  item: ItemRow,
  source: string,
  signal: AbortSignal
): Promise<string> {
  const input = await fsp.open(source, "r");
  let output: Awaited<ReturnType<typeof fsp.open>> | undefined;
  try {
    const before = await input.stat();
    if (!sameVersion(before, item)) {
      outputError("OUTPUT_SOURCE_CHANGED");
    }
    output = await fsp.open(item.tempPath, "wx");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    let position = 0;
    let lastProgress = 0;
    updateItem(item.id, { status: "copying", copiedBytes: 0, error: null });
    while (position < before.size) {
      assertRunning(signal);
      const { bytesRead } = await input.read(
        buffer,
        0,
        Math.min(buffer.length, before.size - position),
        position
      );
      if (bytesRead === 0) {
        outputError("OUTPUT_SOURCE_CHANGED");
      }
      assertRunning(signal);
      let written = 0;
      while (written < bytesRead) {
        assertRunning(signal);
        const result = await output.write(
          buffer,
          written,
          bytesRead - written,
          position + written
        );
        if (result.bytesWritten === 0) {
          outputError("OUTPUT_FAILED");
        }
        written += result.bytesWritten;
      }
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
      if (position === before.size || Date.now() - lastProgress >= 100) {
        updateItem(item.id, { copiedBytes: position });
        lastProgress = Date.now();
      }
    }
    await output.sync();
    if (
      !(
        sameOpenFile(before, await input.stat()) &&
        sameOpenFile(before, await fsp.stat(source))
      )
    ) {
      outputError("OUTPUT_SOURCE_CHANGED");
    }
    const digest = hash.digest("hex");
    const expectedHash = item.sourceHash ?? item.sha256;
    if (expectedHash && expectedHash !== digest) {
      outputError("OUTPUT_SOURCE_CHANGED");
    }
    return digest;
  } finally {
    await output?.close();
    await input.close();
  }
}

async function commitTemporary(item: ItemRow): Promise<void> {
  try {
    await fsp.link(item.tempPath, item.targetPath);
  } catch (error) {
    if (
      !["ENOTSUP", "EOPNOTSUPP", "EPERM", "EXDEV"].includes(
        (error as NodeJS.ErrnoException).code ?? ""
      )
    ) {
      throw error;
    }
    // Node's copyFile may remove its own incomplete destination after an I/O
    // error. Protected Temp contents must never be removed, so only the
    // atomic no-overwrite hard-link commit is permitted for such subfolders.
    if (hasProtectedComponent(item.targetPath)) {
      outputError("OUTPUT_INVALID_TARGET");
    }
    // Some removable filesystems do not support hard links. COPYFILE_EXCL
    // preserves the no-overwrite contract; committing stays durable until the
    // final pathname itself passes the full checksum below.
    await fsp.copyFile(
      item.tempPath,
      item.targetPath,
      fs.constants.COPYFILE_EXCL
    );
  }
}

async function assertTargetVacant(targetPath: string): Promise<void> {
  try {
    await fsp.lstat(targetPath);
    outputError("OUTPUT_CONFLICT");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

function preserveCommitForRecheck(item: ItemRow, code: string): boolean {
  if (code === "OUTPUT_CANCELLED") {
    return true;
  }
  if (canRecheckOutputLater(code)) {
    updateItem(item.id, { error: "OUTPUT_RECHECK_UNAVAILABLE" });
    return true;
  }
  return false;
}

async function runItem(
  task: OutputRow,
  item: ItemRow,
  signal: AbortSignal
): Promise<void> {
  let recheckingCommit =
    item.status === "completed" || item.status === "committing";
  let committing = false;
  let finalCreated = false;
  try {
    assertRunning(signal);
    await validateTargetPaths(task, item, item.status !== "completed");
    if (await recoverCommittedItem(task, item, signal)) {
      return;
    }
    recheckingCommit = false;
    await assertTargetVacant(item.targetPath);
    const source = await assertSourceVersion(item);
    await removeOwnedTemporary(task, item);
    const digest = await copyAndHash(item, source, signal);
    assertRunning(signal);
    updateItem(item.id, { status: "verifying" });
    if ((await fullHash(item.tempPath, signal)) !== digest) {
      outputError("OUTPUT_VERIFY_FAILED");
    }
    // Persist the expected complete hash before the pathname can become final.
    updateItem(item.id, { status: "committing", sha256: digest });
    committing = true;
    assertRunning(signal);
    await commitTemporary(item);
    finalCreated = true;
    if ((await fullHash(item.targetPath, signal)) !== digest) {
      outputError("OUTPUT_VERIFY_FAILED");
    }
    markCompleted(task, item, digest);
    await removeOwnedTemporary(task, item);
  } catch (error) {
    const code = errorCode(error);
    if (recheckingCommit && preserveCommitForRecheck(item, code)) {
      return;
    }
    // A final file might already exist after a committed-but-unrecorded crash.
    // Keep the commit receipt so a later explicit retry can reconcile it.
    const keepReceipt =
      (committing && finalCreated) ||
      (item.status === "committing" && code === "OUTPUT_FAILED");
    updateItem(
      item.id,
      keepReceipt
        ? { status: "committing", error: code }
        : {
            status: code === "OUTPUT_CANCELLED" ? "cancelled" : "failed",
            error: code,
          }
    );
    if (!keepReceipt) {
      await removeOwnedTemporary(task, item).catch(() => undefined);
    }
  }
}

async function runOutput(task: OutputRow, active: ActiveOutput): Promise<void> {
  getDatabase()
    .update(shootingProjectOutputs)
    .set({ status: "running", completedAt: null })
    .where(eq(shootingProjectOutputs.id, task.id))
    .run();
  for (const item of itemsForTask(task.id)) {
    if (active.controller.signal.aborted) {
      break;
    }
    await runItem(task, item, active.controller.signal);
  }
  const items = itemsForTask(task.id);
  const aborted = active.controller.signal.aborted;
  const completed = items.every(
    (item) => item.status === "completed" && item.error === null
  );
  let status: OutputRow["status"] = completed ? "completed" : "failed";
  if (aborted) {
    status = active.reason === "shutdown" ? "interrupted" : "cancelled";
  }
  getDatabase()
    .update(shootingProjectOutputs)
    .set({ status, completedAt: status === "completed" ? Date.now() : null })
    .where(eq(shootingProjectOutputs.id, task.id))
    .run();
}

function beginOutput(task: OutputRow): void {
  if (activeOutputs.has(task.id)) {
    outputError("OUTPUT_BUSY");
  }
  const active: ActiveOutput = {
    projectId: task.projectId,
    controller: new AbortController(),
    reason: "cancel",
    promise: Promise.resolve(),
  };
  activeOutputs.set(task.id, active);
  active.promise = runOutput(task, active)
    .catch(() => {
      try {
        getDatabase()
          .update(shootingProjectOutputs)
          .set({
            status: active.controller.signal.aborted ? "interrupted" : "failed",
            completedAt: null,
          })
          .where(eq(shootingProjectOutputs.id, task.id))
          .run();
      } catch {
        // Keep the last durable stage for startup recovery if the database is
        // temporarily unavailable; never turn the background task into an
        // unhandled rejection during application shutdown.
      }
    })
    .finally(() => {
      activeOutputs.delete(task.id);
    });
}

export async function listShootingProjectOutputs(
  projectId: string
): Promise<ShootingProjectOutputTask[]> {
  projectRow(projectId);
  return await Promise.resolve(
    getDatabase()
      .select()
      .from(shootingProjectOutputs)
      .where(eq(shootingProjectOutputs.projectId, projectId))
      .orderBy(
        desc(shootingProjectOutputs.createdAt),
        desc(shootingProjectOutputs.id)
      )
      .all()
      .map(describeTask)
  );
}

export async function retryShootingProjectOutput(input: {
  projectId: string;
  taskId: string;
  acknowledgeWatchedTarget?: boolean;
}): Promise<ShootingProjectOutputTask> {
  if (stopping || activeOutputs.has(input.taskId)) {
    outputError("OUTPUT_BUSY");
  }
  const generation = outputGeneration(input.projectId);
  const task = taskRow(input.projectId, input.taskId);
  const project = projectRow(input.projectId);
  const source = await fsp
    .realpath(project.sourceRoot)
    .catch(() => project.sourceRoot);
  assertOutputGeneration(input.projectId, generation);
  if (isWithinProjectRoot(source, task.targetRoot)) {
    outputError("OUTPUT_TARGET_INSIDE_SOURCE");
  }
  assertWatchedTargetAcknowledged(
    task,
    itemsForTask(task.id).map((item) => item.relativePath),
    input.acknowledgeWatchedTarget
  );
  beginOutput(task);
  return describeTask(taskRow(input.projectId, task.id));
}

export async function cancelShootingProjectOutput(input: {
  projectId: string;
  taskId: string;
}): Promise<ShootingProjectOutputTask> {
  const generation = outputGeneration(input.projectId);
  assertOutputGeneration(input.projectId, generation);
  taskRow(input.projectId, input.taskId);
  const active = activeOutputs.get(input.taskId);
  if (active) {
    active.reason = "cancel";
    active.controller.abort();
    await active.promise;
  } else {
    const task = taskRow(input.projectId, input.taskId);
    if (task.status !== "completed") {
      getDatabase()
        .update(shootingProjectOutputs)
        .set({ status: "cancelled" })
        .where(eq(shootingProjectOutputs.id, task.id))
        .run();
    }
  }
  assertOutputGeneration(input.projectId, generation);
  const cancelled = taskRow(input.projectId, input.taskId);
  for (const item of itemsForTask(cancelled.id)) {
    await removeOwnedTemporary(cancelled, item).catch(() => undefined);
  }
  assertOutputGeneration(input.projectId, generation);
  return describeTask(taskRow(input.projectId, input.taskId));
}

export async function stopShootingProjectOutputTasks(
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
    projectGenerations.clear();
  }
  for (const [token, receipt] of outputInspections) {
    if (!projectId || receipt.projectId === projectId) {
      outputInspections.delete(token);
    }
  }
  const selected = [...activeOutputs.values()].filter(
    (active) => !projectId || active.projectId === projectId
  );
  for (const active of selected) {
    active.reason = "shutdown";
    active.controller.abort();
  }
  const committing = [...outputCommits.values()].filter(
    (operation) => !projectId || operation.projectId === projectId
  );
  await Promise.allSettled([
    ...selected.map((active) => active.promise),
    ...committing.map((operation) => operation.promise),
  ]);
}

export function startShootingProjectOutputServices(): void {
  stopping = false;
  if (activeOutputs.size > 0) {
    return;
  }
  getDatabase().transaction((db) => {
    db.update(shootingProjectOutputs)
      .set({ status: "interrupted", completedAt: null })
      .where(inArray(shootingProjectOutputs.status, ["running", "pending"]))
      .run();
    db.update(shootingProjectOutputItems)
      .set({ status: "pending", copiedBytes: 0 })
      .where(
        inArray(shootingProjectOutputItems.status, ["copying", "verifying"])
      )
      .run();
  });
}

export async function resolveShootingProjectCompletedOutputFiles(input: {
  projectId: string;
  taskId: string;
}): Promise<{ photoId: string; path: string }[]> {
  const generation = outputGeneration(input.projectId);
  const assertActive = () =>
    assertOutputGeneration(input.projectId, generation);
  assertActive();
  const task = taskRow(input.projectId, input.taskId);
  if (task.status !== "completed") {
    outputError("OUTPUT_INCOMPLETE");
  }
  const items = itemsForTask(task.id);
  for (const item of items) {
    assertActive();
    try {
      await validateTargetPaths(task, item, false);
      if (
        item.status !== "completed" ||
        !item.sha256 ||
        (await fullHash(item.targetPath)) !== item.sha256
      ) {
        outputError("OUTPUT_CONFLICT");
      }
    } catch (error) {
      assertActive();
      const code = errorCode(error);
      const temporary =
        item.status === "completed" && canRecheckOutputLater(code);
      getDatabase().transaction((db) => {
        db.update(shootingProjectOutputItems)
          .set(
            temporary
              ? { error: "OUTPUT_RECHECK_UNAVAILABLE" }
              : { status: "failed", error: "OUTPUT_CONFLICT" }
          )
          .where(eq(shootingProjectOutputItems.id, item.id))
          .run();
        db.update(shootingProjectOutputs)
          .set({ status: "failed", completedAt: null })
          .where(eq(shootingProjectOutputs.id, task.id))
          .run();
      });
      if (temporary) {
        outputError("OUTPUT_RECHECK_UNAVAILABLE");
      }
      if (error instanceof ShootingProjectOutputError) {
        throw error;
      }
      outputError("OUTPUT_CONFLICT");
    }
  }
  assertActive();
  return items
    .filter((item) => item.kind === "original")
    .map((item) => ({ photoId: item.photoId, path: item.targetPath }));
}
