import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { and, eq } from "drizzle-orm";
import { app } from "electron";
import { getDatabase } from "@/db";
import { contentCredentialResults, photos } from "@/db/schema";
import { aiSourceReady } from "@/services/ai/photo-version";
import {
  contentCredentialToolFailure,
  parseContentCredentialResult,
} from "@/services/content-credential-result";
import {
  type ContentCredentialVerification,
  type SavedContentCredentialVerification,
  supportsContentCredentialVerification,
} from "@/types/photo-metadata";
import { registerGalleryCleanup } from "@/utils/gallery-lifecycle";

const executeFile = promisify(execFile);
const TOOL_FILES = ["c2patool.exe", "c2pa.toml", "c2pa-trust-list.pem"];
let galleryGeneration = 0;
let active: AbortController | undefined;

registerGalleryCleanup(() => {
  galleryGeneration++;
  active?.abort();
  active = undefined;
});

function toolDirectory() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "content-credential-tool")
    : path.join(app.getAppPath(), ".test-runtime", "content-credential-tool");
}

export function hasContentCredentialTool(): boolean {
  return (
    process.platform === "win32" &&
    process.arch === "x64" &&
    TOOL_FILES.every((name) => existsSync(path.join(toolDirectory(), name)))
  );
}

async function readStamp(filePath: string) {
  const file = await stat(filePath, { bigint: true }).catch(() => null);
  return file?.isFile()
    ? [file.dev, file.ino, file.size, file.mtimeNs, file.ctimeNs].join(":")
    : null;
}

async function currentSource(photoId: number) {
  const db = getDatabase();
  const generation = galleryGeneration;
  const selectPhoto = () =>
    db
      .select({
        path: photos.path,
        fileRevision: photos.fileRevision,
        contentRevision: photos.contentRevision,
      })
      .from(photos)
      .where(and(eq(photos.id, photoId), aiSourceReady))
      .get();
  const photo = selectPhoto();
  if (!photo) {
    return null;
  }
  const parsed = path.parse(photo.path);
  const [file, sidecar, ...toolStamps] = await Promise.all([
    readStamp(photo.path),
    readStamp(path.join(parsed.dir, `${parsed.name}.c2pa`)),
    ...TOOL_FILES.map((name) => readStamp(path.join(toolDirectory(), name))),
  ]);
  if (
    !file ||
    toolStamps.includes(null) ||
    generation !== galleryGeneration ||
    JSON.stringify(photo) !== JSON.stringify(selectPhoto())
  ) {
    return null;
  }
  return {
    db,
    generation,
    path: photo.path,
    format: parsed.ext.slice(1),
    stamp: hashStamp([photo, file, sidecar, toolStamps]),
  };
}

function hashStamp(parts: unknown[]) {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function sessionStamp(source: { generation: number; stamp: string }) {
  return hashStamp([source.generation, source.stamp]);
}

export async function isContentCredentialCurrent(
  photoId: number,
  stamp: string
): Promise<boolean> {
  const source = await currentSource(photoId);
  return Boolean(source && sessionStamp(source) === stamp);
}

export async function readSavedContentCredential(photoId: number) {
  const db = getDatabase();
  const stored = db
    .select()
    .from(contentCredentialResults)
    .where(eq(contentCredentialResults.photoId, photoId))
    .get();
  if (!stored) {
    return null;
  }
  const source = await currentSource(photoId);
  if (!source || source.db !== db || stored.sourceStamp !== source.stamp) {
    return null;
  }
  return { ...stored.result, stamp: sessionStamp(source) };
}

function isSaveable(
  result: ContentCredentialVerification
): result is SavedContentCredentialVerification {
  return (
    result.status === "checked" ||
    result.status === "no_credential" ||
    result.status === "remote"
  );
}

export async function verifyPhotoContentCredential(
  photoId: number
): Promise<ContentCredentialVerification & { stamp?: string }> {
  if (!hasContentCredentialTool()) {
    return { status: "unavailable" };
  }
  if (active) {
    return { status: "busy" };
  }
  const controller = new AbortController();
  active = controller;
  try {
    const source = await currentSource(photoId);
    if (!source) {
      return { status: "file_changed" };
    }
    if (!supportsContentCredentialVerification(source.format)) {
      return { status: "unsupported" };
    }
    const dir = toolDirectory();
    const execution = await executeFile(
      path.join(dir, "c2patool.exe"),
      [source.path, "--settings", path.join(dir, "c2pa.toml")],
      {
        cwd: dir,
        maxBuffer: 8 * 1024 * 1024,
        signal: controller.signal,
        timeout: 20_000,
        windowsHide: true,
      }
    ).then(
      ({ stdout }) => parseContentCredentialResult(stdout),
      (error: { stderr?: string }) =>
        contentCredentialToolFailure(error.stderr ?? "")
    );
    const stamp = sessionStamp(source);
    const current = await isContentCredentialCurrent(photoId, stamp);
    if (!current || controller.signal.aborted) {
      return { status: "file_changed" };
    }
    if (isSaveable(execution)) {
      const value = { result: execution, sourceStamp: source.stamp };
      source.db
        .insert(contentCredentialResults)
        .values({ photoId, ...value })
        .onConflictDoUpdate({
          target: contentCredentialResults.photoId,
          set: value,
        })
        .run();
      return { ...execution, stamp };
    }
    return execution;
  } catch {
    return { status: "error" };
  } finally {
    if (active === controller) {
      active = undefined;
    }
  }
}
