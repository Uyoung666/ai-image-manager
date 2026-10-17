import fsp from "node:fs/promises";
import path from "node:path";
import yauzl from "yauzl";
import {
  parseUpdateManifest,
  type UpdatePackage,
} from "@/services/github-update";
import { recordUpdateError } from "@/services/update-error";

export const UPDATE_SPACE_RESERVE = 512 * 1024 * 1024;
export const UPDATE_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

interface SpaceRequest {
  bytes: number;
  directory: string;
}

async function existingAncestor(directory: string): Promise<string> {
  let candidate = path.resolve(directory);
  for (;;) {
    try {
      await fsp.stat(candidate);
      return candidate;
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "ENOENT" ||
        candidate === path.dirname(candidate)
      ) {
        throw error;
      }
      candidate = path.dirname(candidate);
    }
  }
}

/** Group requests by the actual filesystem, including separate paths on one volume. */
export async function assertUpdateSpace(
  requests: SpaceRequest[]
): Promise<void> {
  const volumes = new Map<string, { available: bigint; required: bigint }>();
  for (const request of requests) {
    try {
      const ancestor = await existingAncestor(request.directory);
      const [stat, space] = await Promise.all([
        fsp.stat(ancestor, { bigint: true }),
        fsp.statfs(ancestor, { bigint: true }),
      ]);
      const key = String(stat.dev);
      const available = space.bavail * space.bsize;
      const existing = volumes.get(key);
      const minimumAvailable =
        existing && existing.available < available
          ? existing.available
          : available;
      volumes.set(key, {
        available: minimumAvailable,
        required:
          (existing?.required ?? BigInt(UPDATE_SPACE_RESERVE)) +
          BigInt(Math.ceil(request.bytes)),
      });
    } catch (error) {
      // A failed query must not prevent updates on unusual filesystems.
      recordUpdateError(error, "query-update-space");
    }
  }
  for (const volume of volumes.values()) {
    if (volume.available < volume.required) {
      throw new Error("UPDATE_DISK_SPACE");
    }
  }
}

async function fileSize(file: string): Promise<number> {
  try {
    return (await fsp.stat(file)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return 0;
    }
    throw error;
  }
}

export async function assertUpdateDownloadSpace(
  info: UpdatePackage,
  destination: string
): Promise<void> {
  const size = await fileSize(`${destination}.download`);
  // An oversized partial will be discarded by the downloader.
  const reusable = size < info.size ? size : 0;
  await assertUpdateSpace([
    { directory: path.dirname(destination), bytes: info.size - reusable },
  ]);
}

export async function updateDirectorySize(directory: string): Promise<number> {
  let size = 0;
  for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    const stat = await fsp.lstat(file);
    if (stat.isSymbolicLink()) {
      continue;
    }
    if (stat.isDirectory()) {
      size += await updateDirectorySize(file);
    } else if (stat.isFile()) {
      size += stat.size;
    }
  }
  return size;
}

export function updatePackageExpandedSize(file: string): Promise<number> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: true }, (error, zip) => {
      if (error || !zip) {
        reject(error ?? new Error("Invalid update package"));
        return;
      }
      let size = 0;
      zip.on("error", reject);
      zip.on("entry", (entry: yauzl.Entry) => {
        size += entry.uncompressedSize;
        if (!Number.isSafeInteger(size)) {
          zip.close();
          reject(new Error("Invalid update package expanded size"));
          return;
        }
        zip.readEntry();
      });
      zip.on("end", () => resolve(size));
      zip.readEntry();
    });
  });
}

export async function assertUpdateInstallSpace(options: {
  packagePath: string;
  method: "delta" | "full";
  fullSize: number;
  applicationDirectory: string;
  installRoot: string;
  temporaryDirectory: string;
}): Promise<void> {
  let expanded: number;
  try {
    expanded =
      options.method === "full"
        ? await updatePackageExpandedSize(options.packagePath)
        : Math.max(
            await updateDirectorySize(options.applicationDirectory),
            options.fullSize * 3
          );
  } catch (error) {
    recordUpdateError(error, "estimate-update-space");
    expanded = options.fullSize * 3;
  }
  await assertUpdateSpace([
    { directory: options.installRoot, bytes: options.fullSize + expanded },
    { directory: options.temporaryDirectory, bytes: expanded },
  ]);
}

/** Refuse every linked ancestor, including Windows directory junctions. */
async function assertUnlinkedPath(target: string): Promise<void> {
  let candidate = path.resolve(target);
  for (;;) {
    if (path.basename(candidate).toLowerCase() === "temp") {
      throw new Error("Protected Temp directory");
    }
    const stat = await fsp.lstat(candidate);
    if (stat.isSymbolicLink()) {
      throw new Error("Linked update cache path");
    }
    if (candidate === path.dirname(candidate)) {
      return;
    }
    candidate = path.dirname(candidate);
  }
}

export async function invalidateUpdatePackage(
  directory: string,
  info: UpdatePackage
): Promise<void> {
  const file = path.resolve(directory, info.filename);
  if (
    path.dirname(file) !== path.resolve(directory) ||
    !info.filename.endsWith(".nupkg")
  ) {
    throw new Error("Invalid update package path");
  }
  await assertUnlinkedPath(directory);
  try {
    await assertUnlinkedPath(file);
    await fsp.unlink(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

export async function touchUpdateCache(directory: string): Promise<void> {
  try {
    const manifest = path.join(directory, "update-manifest.json");
    const now = new Date();
    await fsp.utimes(manifest, now, now);
  } catch (error) {
    recordUpdateError(error, "touch-update-cache");
  }
}

interface CacheCleanupContext {
  canClean: () => boolean;
  now: number;
  protectedVersions: () => Set<string>;
}

async function cleanupVersion(
  directory: string,
  version: string,
  context: CacheCleanupContext
): Promise<void> {
  const allowed = () =>
    context.canClean() && !context.protectedVersions().has(version);
  await assertUnlinkedPath(directory);
  const files = await fsp.readdir(directory);
  const stats = await Promise.all(
    files.map((file) => fsp.lstat(path.join(directory, file)))
  );
  if (
    stats.some(
      (stat) =>
        stat.isSymbolicLink() ||
        context.now - stat.mtimeMs < UPDATE_CACHE_MAX_AGE_MS
    )
  ) {
    return;
  }
  const manifest = parseUpdateManifest(
    JSON.parse(
      await fsp.readFile(path.join(directory, "update-manifest.json"), "utf8")
    )
  );
  if (manifest.version !== version) {
    return;
  }
  const known = new Set(["update-manifest.json", "RELEASES"]);
  for (const info of [manifest.packages.full, manifest.packages.delta]) {
    if (info) {
      known.add(info.filename);
      known.add(`${info.filename}.download`);
    }
  }
  for (const [index, file] of files.entries()) {
    if (!allowed()) {
      return;
    }
    if (known.has(file) && stats[index].isFile()) {
      await assertUnlinkedPath(path.join(directory, file));
      if (!allowed()) {
        return;
      }
      await fsp.unlink(path.join(directory, file));
    }
  }
  if (allowed() && (await fsp.readdir(directory)).length === 0) {
    await assertUnlinkedPath(directory);
    if (allowed()) {
      await fsp.rmdir(directory);
    }
  }
}

/** Never recursively delete: only a validated manifest's known regular files. */
export async function cleanupUpdateCache(
  root: string,
  protectedVersions: () => Set<string>,
  canClean: () => boolean,
  now = Date.now()
): Promise<void> {
  try {
    await assertUnlinkedPath(root);
    for (const entry of await fsp.readdir(root, { withFileTypes: true })) {
      if (!canClean()) {
        return;
      }
      if (!VERSION_RE.test(entry.name) || protectedVersions().has(entry.name)) {
        continue;
      }
      try {
        const directory = path.resolve(root, entry.name);
        if (path.dirname(directory) !== path.resolve(root)) {
          continue;
        }
        await cleanupVersion(directory, entry.name, {
          protectedVersions,
          canClean,
          now,
        });
      } catch (error) {
        recordUpdateError(error, "cleanup-update-version");
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      recordUpdateError(error, "cleanup-update-cache");
    }
  }
}
