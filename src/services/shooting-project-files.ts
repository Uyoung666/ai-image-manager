import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { getDataPath } from "@/utils/data-path";

const ID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const SAMPLE_BYTES = 64 * 1024;

export class ShootingProjectError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "ShootingProjectError";
    this.code = code;
  }
}

export function isWithinProjectRoot(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative === "" ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`))
  );
}

/** Resolve only an actual file below the chosen root, never a linked subtree. */
export async function resolveProjectRelativePath(
  root: string,
  relativePath: string
): Promise<string> {
  if (
    !(path.isAbsolute(root) && relativePath) ||
    path.isAbsolute(relativePath) ||
    relativePath.includes("\0")
  ) {
    throw new ShootingProjectError("INVALID_SOURCE");
  }
  const target = path.resolve(root, relativePath);
  if (target === path.resolve(root) || !isWithinProjectRoot(root, target)) {
    throw new ShootingProjectError("INVALID_SOURCE");
  }
  const rootReal = await fs.realpath(root);
  let current = path.resolve(root);
  for (const part of path.relative(root, target).split(path.sep)) {
    current = path.join(current, part);
    if ((await fs.lstat(current)).isSymbolicLink()) {
      throw new ShootingProjectError("INVALID_SOURCE");
    }
  }
  if (!isWithinProjectRoot(rootReal, await fs.realpath(target))) {
    throw new ShootingProjectError("INVALID_SOURCE");
  }
  if (!(await fs.stat(target)).isFile()) {
    throw new ShootingProjectError("INVALID_SOURCE");
  }
  return target;
}

export async function hashProjectFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

/** A sampled fingerprint is evidence for an explicit candidate, not a full hash. */
export async function getLightweightFingerprint(
  filePath: string
): Promise<string> {
  const handle = await fs.open(filePath, "r");
  try {
    const before = await handle.stat();
    const hash = createHash("sha256").update(String(before.size));
    for (const offset of new Set([
      0,
      Math.max(0, Math.floor(before.size / 2) - SAMPLE_BYTES / 2),
      Math.max(0, before.size - SAMPLE_BYTES),
    ])) {
      const buffer = Buffer.alloc(Math.min(SAMPLE_BYTES, before.size - offset));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      hash.update(String(offset)).update(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new ShootingProjectError("SOURCE_CHANGED");
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

export function projectPreviewDirectory(projectId: string): string {
  if (!ID_PATTERN.test(projectId)) {
    throw new ShootingProjectError("NOT_FOUND");
  }
  return path.join(getDataPath(), "shooting-projects", projectId);
}

export function projectPreviewPath(projectId: string, photoId: string): string {
  if (!ID_PATTERN.test(photoId)) {
    throw new ShootingProjectError("INVALID_PHOTO");
  }
  return path.join(projectPreviewDirectory(projectId), `${photoId}.jpg`);
}

export async function validateProjectPreviewLocation(
  projectId: string,
  create = false
): Promise<string> {
  const directory = path.resolve(projectPreviewDirectory(projectId));
  let current = path.parse(directory).root;
  for (const segment of directory.slice(current.length).split(path.sep)) {
    if (segment.toLowerCase() === "temp") {
      throw new ShootingProjectError("PROTECTED_PATH");
    }
    current = path.join(current, segment);
    try {
      if ((await fs.lstat(current)).isSymbolicLink()) {
        throw new ShootingProjectError("PROTECTED_PATH");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
  if (create) {
    await fs.mkdir(directory, { recursive: true });
    await validateProjectPreviewLocation(projectId);
  }
  return directory;
}

function isProjectPreviewTemporaryName(photoId: string, name: string | null) {
  return (
    ID_PATTERN.test(photoId) &&
    name?.startsWith(`${photoId}-`) &&
    name.endsWith(".jpg.pending") &&
    ID_PATTERN.test(name.slice(photoId.length + 1, -12))
  );
}

/** Recover only the staging file named by this photo's durable receipt. */
export async function removeProjectPreviewTemporary(
  projectId: string,
  photoId: string,
  name: string | null
): Promise<void> {
  if (!(name && isProjectPreviewTemporaryName(photoId, name))) {
    return;
  }
  const directory = await validateProjectPreviewLocation(projectId);
  const filename = path.join(directory, name);
  try {
    const stat = await fs.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new ShootingProjectError("PROTECTED_PATH");
    }
    await fs.unlink(filename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

/** Remove only host-owned UUID JPEGs; protect links, Temp and foreign content. */
export async function removeProjectPreviewFiles(
  projectId: string,
  records: { id: string; previewRelativePath: string | null }[]
): Promise<void> {
  const directory = await validateProjectPreviewLocation(projectId);
  const allowedNames = new Set<string>();
  for (const record of records) {
    if (!ID_PATTERN.test(record.id)) {
      continue;
    }
    allowedNames.add(`${record.id}.jpg`);
    const temporary = record.previewRelativePath;
    if (temporary && isProjectPreviewTemporaryName(record.id, temporary)) {
      allowedNames.add(temporary);
    }
  }
  try {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (!(entry.isFile() && allowedNames.has(entry.name))) {
        continue;
      }
      const filename = path.join(directory, entry.name);
      if (!isWithinProjectRoot(directory, filename)) {
        throw new ShootingProjectError("PROTECTED_PATH");
      }
      await fs.unlink(filename);
    }
    await fs.rmdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOTEMPTY") {
        throw error;
      }
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}
