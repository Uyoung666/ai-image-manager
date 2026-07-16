import fs from "node:fs";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { BrowserWindow } from "electron";
import { exiftool } from "exiftool-vendored";
import { getDatabase } from "@/db";
import { advancedExifData, photos } from "@/db/schema";
import {
  normalizeAdvancedExif,
  sanitizeVendorTags,
} from "@/services/advanced-exif-normalizer";
import type {
  AdvancedExifProgress,
  PhotoMetadata,
} from "@/types/photo-metadata";

export const ADVANCED_EXIF_PARSER_VERSION = 1;
const YIELD_MS = 150;

let running = false;
let paused = false;
let scheduled = false;
let rescanRequested = false;
let progress: AdvancedExifProgress = {
  failed: 0,
  paused: false,
  processed: 0,
  running: false,
  total: 0,
};

function broadcast(): void {
  progress = { ...progress, paused, running };
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send("advanced-exif-progress", progress);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function serializedMetadata(metadata: PhotoMetadata) {
  return {
    vendor: metadata.vendor,
    captureMode: (metadata.capture.captureMode as string | null) ?? null,
    exposureProgram:
      (metadata.standard.exposureProgram as string | null) ?? null,
    meteringMode: (metadata.standard.meteringMode as string | null) ?? null,
    whiteBalance: (metadata.standard.whiteBalance as string | null) ?? null,
    focusMode: (metadata.autofocus.focusMode as string | null) ?? null,
    focusArea: (metadata.autofocus.focusArea as string | null) ?? null,
    subjectTarget: (metadata.autofocus.subjectTarget as string | null) ?? null,
    eyeDetection: (metadata.autofocus.eyeDetection as boolean | null) ?? null,
    tracking: (metadata.autofocus.tracking as boolean | null) ?? null,
    driveMode: (metadata.capture.driveMode as string | null) ?? null,
    stabilizationMode:
      (metadata.processing.stabilizationMode as string | null) ?? null,
    computationalMode:
      (metadata.processing.computationalMode as string | null) ?? null,
    inCameraLook: (metadata.processing.inCameraLook as string | null) ?? null,
    provenanceStatus: metadata.provenance.status,
    provenanceIssuer: metadata.provenance.issuer ?? null,
    normalizedJson: JSON.stringify({ ...metadata, vendorRaw: undefined }),
    vendorRawJson: JSON.stringify(sanitizeVendorTags(metadata.vendorRaw)),
  };
}

async function importQueueBusy(): Promise<boolean> {
  try {
    const { getImportQueueStatus } = await import("@/services/import-queue");
    const status = getImportQueueStatus();
    return Boolean(
      status.current &&
        ["scanning", "embedding"].includes(status.current.status)
    );
  } catch {
    return false;
  }
}

async function waitUntilAvailable(): Promise<void> {
  while (paused || (await importQueueBusy())) {
    broadcast();
    await delay(500);
  }
}

async function enrichPhoto(photo: { id: number; path: string }): Promise<void> {
  const db = getDatabase();
  const base = {
    photoId: photo.id,
    parserVersion: ADVANCED_EXIF_PARSER_VERSION,
  };
  db.insert(advancedExifData)
    .values({ ...base, status: "processing" })
    .onConflictDoUpdate({
      target: advancedExifData.photoId,
      set: { status: "processing", errorMessage: null },
    })
    .run();

  if (!fs.existsSync(photo.path)) {
    db.update(advancedExifData)
      .set({
        status: "failed",
        enrichedAt: Date.now(),
        errorMessage: "Source file is missing",
      })
      .where(eq(advancedExifData.photoId, photo.id))
      .run();
    throw new Error("Source file is missing");
  }

  try {
    const raw = (await exiftool.readRaw(photo.path, {
      readArgs: ["-G1", "-a", "-s", "-struct"],
    })) as Record<string, unknown>;
    const metadata = normalizeAdvancedExif(raw);
    const serialized = serializedMetadata(metadata);
    const hasAdvancedValue = [
      serialized.captureMode,
      serialized.focusMode,
      serialized.subjectTarget,
      serialized.computationalMode,
      serialized.inCameraLook,
      serialized.vendor,
    ].some(Boolean);

    db.update(advancedExifData)
      .set({
        ...serialized,
        status: hasAdvancedValue ? "complete" : "partial",
        parserVersion: ADVANCED_EXIF_PARSER_VERSION,
        enrichedAt: Date.now(),
        errorMessage: null,
      })
      .where(eq(advancedExifData.photoId, photo.id))
      .run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    db.update(advancedExifData)
      .set({
        status: "failed",
        parserVersion: ADVANCED_EXIF_PARSER_VERSION,
        enrichedAt: Date.now(),
        errorMessage: message.slice(0, 500),
      })
      .where(eq(advancedExifData.photoId, photo.id))
      .run();
    throw error;
  }
}

function pendingPhotos() {
  const db = getDatabase();
  return db
    .select({ id: photos.id, path: photos.path })
    .from(photos)
    .leftJoin(advancedExifData, eq(advancedExifData.photoId, photos.id))
    .where(
      and(
        isNull(photos.deletedAt),
        or(
          isNull(advancedExifData.photoId),
          lt(advancedExifData.parserVersion, ADVANCED_EXIF_PARSER_VERSION),
          eq(advancedExifData.status, "pending"),
          eq(advancedExifData.status, "processing")
        )
      )
    )
    .all();
}

export async function runAdvancedExifEnrichment(): Promise<AdvancedExifProgress> {
  if (running) {
    return progress;
  }
  running = true;
  scheduled = false;
  const candidates = pendingPhotos();
  progress = {
    failed: 0,
    paused,
    processed: 0,
    running: true,
    total: candidates.length,
  };
  broadcast();

  for (const photo of candidates) {
    await waitUntilAvailable();
    try {
      await enrichPhoto(photo);
    } catch {
      progress.failed += 1;
    }
    progress.processed += 1;
    broadcast();
    await delay(YIELD_MS);
  }

  running = false;
  broadcast();
  if (rescanRequested) {
    rescanRequested = false;
    scheduleAdvancedExifEnrichment(250);
  }
  return progress;
}

export function scheduleAdvancedExifEnrichment(delayMs = 1000): void {
  if (scheduled || running) {
    if (running) {
      rescanRequested = true;
    }
    return;
  }
  scheduled = true;
  setTimeout(() => {
    runAdvancedExifEnrichment().catch(() => {
      running = false;
      scheduled = false;
      broadcast();
    });
  }, delayMs);
}

export function pauseAdvancedExifEnrichment(): AdvancedExifProgress {
  paused = true;
  broadcast();
  return progress;
}

export function resumeAdvancedExifEnrichment(): AdvancedExifProgress {
  paused = false;
  broadcast();
  scheduleAdvancedExifEnrichment(0);
  return progress;
}

export function retryAdvancedExifFailures(): AdvancedExifProgress {
  getDatabase()
    .update(advancedExifData)
    .set({ status: "pending", errorMessage: null })
    .where(eq(advancedExifData.status, "failed"))
    .run();
  scheduleAdvancedExifEnrichment(0);
  return progress;
}

export function getAdvancedExifProgress(): AdvancedExifProgress {
  if (!running) {
    const db = getDatabase();
    const counts = db
      .select({
        failed: sql<number>`SUM(CASE WHEN ${advancedExifData.status} = 'failed' THEN 1 ELSE 0 END)`,
        processed: sql<number>`SUM(CASE WHEN ${advancedExifData.status} IN ('complete', 'partial', 'unsupported', 'failed') THEN 1 ELSE 0 END)`,
        total: sql<number>`COUNT(*)`,
      })
      .from(advancedExifData)
      .get();
    progress = {
      failed: counts?.failed ?? 0,
      paused,
      processed: counts?.processed ?? 0,
      running,
      total: counts?.total ?? 0,
    };
  }
  return progress;
}
