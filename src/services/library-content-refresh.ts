import fs from "node:fs/promises";
import { and, eq, exists, isNull, lt, sql } from "drizzle-orm";
import { getDatabase } from "@/db";
import {
  advancedExifData,
  duplicatePhotoFingerprints,
  duplicateReviewGroups,
  duplicateReviewMembers,
  exifData,
  libraryRefreshJobs,
  photos,
  photoTags,
} from "@/db/schema";
import type { LibraryRefreshMode } from "@/types/library-reliability";
import { createLogger } from "@/utils/logger";
import { resetEmbeddingRefreshRetry } from "./ai/embedding-refresh-retries";
import { FULL_FILE_HASH_VERSION } from "./file-hash";
import { hashLibraryFile } from "./library-moves";
import type { LibraryFileObservation } from "./library-source";
import { invalidateVectorSearch } from "./search-revision";

const log = createLogger("library-content-refresh");
const MAX_ATTEMPTS = 4;
type RefreshDb = ReturnType<typeof getDatabase>;
type RefreshJob = typeof libraryRefreshJobs.$inferSelect;
type RefreshPhase = RefreshJob["phase"];
let generation = 0;
let running = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let active: Promise<void> | undefined;
let refreshRequestId = Date.now();

function preparePhotoReader(db: ReturnType<typeof getDatabase>) {
  return db
    .select({
      id: photos.id,
      path: photos.path,
      deletedAt: photos.deletedAt,
      sourceStatus: photos.sourceStatus,
      sourceSize: photos.sourceSize,
      sourceMtimeMs: photos.sourceMtimeMs,
      sourceCtimeMs: photos.sourceCtimeMs,
      refreshStatus: photos.refreshStatus,
      metadataRevision: photos.metadataRevision,
      embeddingRevision: photos.embeddingRevision,
      colorRevision: photos.colorRevision,
      isAiProcessed: photos.isAiProcessed,
      embeddingRefreshAttempts: photos.embeddingRefreshAttempts,
      sourceHash: photos.sourceHash,
      sourceHashVersion: photos.sourceHashVersion,
      sourceHashFileRevision: photos.sourceHashFileRevision,
      fileRevision: photos.fileRevision,
      contentRevision: photos.contentRevision,
      isFaceProcessed: photos.isFaceProcessed,
      faceRefreshPending: photos.faceRefreshPending,
    })
    .from(photos)
    .where(eq(photos.id, sql.placeholder("photoId")))
    .prepare();
}

const photoReaders = new WeakMap<
  ReturnType<typeof getDatabase>,
  ReturnType<typeof preparePhotoReader>
>();

function readPhoto(db: ReturnType<typeof getDatabase>, photoId: number) {
  let reader = photoReaders.get(db);
  if (!reader) {
    reader = preparePhotoReader(db);
    photoReaders.set(db, reader);
  }
  return reader.get({ photoId });
}

function fileState(stat: { size: number; mtimeMs: number; ctimeMs: number }) {
  return {
    sourceSize: stat.size,
    sourceMtimeMs: stat.mtimeMs,
    sourceCtimeMs: stat.ctimeMs,
  };
}

async function readCurrentFileState(
  filePath: string,
  isCurrent: () => boolean
): Promise<ReturnType<typeof fileState> | null> {
  const stat = await fs.stat(filePath).catch(() => null);
  return stat?.isFile() && isCurrent() ? fileState(stat) : null;
}

function sameFileState(
  first:
    | ReturnType<typeof fileState>
    | Pick<
        typeof photos.$inferSelect,
        "sourceSize" | "sourceMtimeMs" | "sourceCtimeMs"
      >,
  second: ReturnType<typeof fileState>
): boolean {
  return (
    first.sourceSize === second.sourceSize &&
    first.sourceMtimeMs === second.sourceMtimeMs &&
    first.sourceCtimeMs === second.sourceCtimeMs
  );
}

interface ObserveLibraryPhotoOptions {
  force?: boolean;
  verifiedObservation?: LibraryFileObservation;
}

function unchangedScanState(
  row: Pick<
    typeof photos.$inferSelect,
    "sourceSize" | "sourceMtimeMs" | "sourceCtimeMs"
  >,
  options?: ObserveLibraryPhotoOptions
): ReturnType<typeof fileState> | null {
  if (!options?.verifiedObservation || options.force) {
    return null;
  }
  const state = fileState(options.verifiedObservation);
  return sameFileState(row, state) ? state : null;
}

function stillCurrent(
  row: Pick<
    typeof photos.$inferSelect,
    "id" | "path" | "fileRevision" | "contentRevision"
  >
) {
  return and(
    eq(photos.id, row.id),
    eq(photos.path, row.path),
    eq(photos.fileRevision, row.fileRevision),
    eq(photos.contentRevision, row.contentRevision),
    isNull(photos.deletedAt),
    eq(photos.sourceStatus, "available")
  );
}

async function publish(id: number): Promise<void> {
  const { notifyLibraryChange } = await import("./library-change");
  notifyLibraryChange(id, "update");
}

function queueRefresh(
  tx: Pick<RefreshDb, "insert">,
  photoId: number,
  contentRevision: number,
  phase: RefreshPhase = "metadata",
  repairPreview = false
): void {
  refreshRequestId = Math.max(Date.now(), refreshRequestId + 1);
  tx.insert(libraryRefreshJobs)
    .values({
      photoId,
      contentRevision,
      phase,
      repairPreview,
      requestId: refreshRequestId,
    })
    .onConflictDoUpdate({
      target: libraryRefreshJobs.photoId,
      set: {
        contentRevision,
        phase,
        repairPreview,
        requestId: refreshRequestId,
        attempts: 0,
        retryAt: 0,
      },
    })
    .run();
}

/** Invalidate derived evidence inside the transaction accepting new bytes. */
export function invalidateLibraryPhotoContent(
  tx: Pick<ReturnType<typeof getDatabase>, "delete" | "insert" | "update">,
  id: number,
  contentRevision: number,
  wasFaceProcessed = false
): void {
  if (wasFaceProcessed) {
    tx.update(photos)
      .set({
        faceRefreshPending: true,
        faceRefreshAttempts: 0,
        faceRefreshRetryAt: 0,
      })
      .where(eq(photos.id, id))
      .run();
  }
  queueRefresh(tx, id, contentRevision);
  tx.delete(advancedExifData).where(eq(advancedExifData.photoId, id)).run();
  tx.delete(photoTags)
    .where(
      and(
        eq(photoTags.photoId, id),
        eq(photoTags.origin, "auto"),
        eq(photoTags.userConfirmed, false)
      )
    )
    .run();
  tx.update(duplicatePhotoFingerprints)
    .set({
      contentRevision: sql`${duplicatePhotoFingerprints.contentRevision} + 1`,
      fullSha256: null,
      sampleHash: null,
      verifiedAt: null,
    })
    .where(eq(duplicatePhotoFingerprints.photoId, id))
    .run();
  tx.update(duplicateReviewGroups)
    .set({
      needsReview: true,
      complete: false,
      reviewRevision: sql`${duplicateReviewGroups.reviewRevision} + 1`,
    })
    .where(
      sql`${duplicateReviewGroups.groupKey} IN (SELECT group_key FROM duplicate_review_members WHERE photo_id = ${id})`
    )
    .run();
  tx.update(duplicateReviewMembers)
    .set({ needsReview: true })
    .where(eq(duplicateReviewMembers.photoId, id))
    .run();
}

/** Observe a verified accessible path without replacing its catalogue identity. */
export async function observeLibraryPhoto(
  id: number,
  filePath: string,
  options?: ObserveLibraryPhotoOptions
): Promise<boolean> {
  const observedGeneration = generation;
  const db = getDatabase();
  const row = readPhoto(db, id);
  if (
    !row ||
    row.path !== filePath ||
    row.deletedAt !== null ||
    row.sourceStatus !== "available"
  ) {
    return false;
  }
  // Reuse the scan's final stat only for the unchanged fast path. Writing a
  // baseline or accepting any possible change still requires fresh evidence.
  const before =
    unchangedScanState(row, options) ??
    (await readCurrentFileState(
      filePath,
      () => observedGeneration === generation && db === getDatabase()
    ));
  if (!before) {
    return false;
  }
  if (!options?.force && sameFileState(row, before)) {
    if (row.refreshStatus === "pending") {
      scheduleRefresh(0);
    }
    return false;
  }
  if (row.sourceSize === null && !options?.force) {
    // An upgrade has no earlier byte evidence. Establish a baseline without
    // discarding historic AI work or asserting it describes these bytes.
    db.update(photos).set(before).where(stillCurrent(row)).run();
    return false;
  }
  const hash = await hashLibraryFile(filePath);
  const after = await fs.stat(filePath).catch(() => null);
  if (
    !(hash && after?.isFile() && sameFileState(before, fileState(after))) ||
    observedGeneration !== generation ||
    db !== getDatabase()
  ) {
    return false;
  }
  const sameContent =
    row.sourceHash === hash &&
    row.sourceHashVersion === FULL_FILE_HASH_VERSION &&
    row.sourceHashFileRevision === row.fileRevision;
  if (sameContent && sameFileState(row, before)) {
    scheduleRefresh(0);
    return false;
  }
  const nextFileRevision = row.fileRevision + 1;
  const nextContentRevision = row.contentRevision + (sameContent ? 0 : 1);
  const accepted = db.transaction((tx) => {
    const update = tx
      .update(photos)
      .set({
        ...before,
        fileRevision: nextFileRevision,
        sourceHash: hash,
        sourceHashVersion: FULL_FILE_HASH_VERSION,
        sourceHashFileRevision: nextFileRevision,
        ...(sameContent
          ? {}
          : {
              contentRevision: nextContentRevision,
              refreshStatus: "pending" as const,
              refreshError: null,
              isAiProcessed: false,
              isFaceProcessed: false,
              faceProcessingError: null,
              vectorId: null,
              phash: null,
              contentHash: null,
              colorBucket: null,
              dominantColors: null,
              duelPreviewPath: null,
              thumbnailPath: null,
              thumbnailSize: null,
            }),
      })
      .where(stillCurrent(row))
      .run();
    if (update.changes !== 1 || sameContent) {
      return false;
    }
    invalidateLibraryPhotoContent(
      tx,
      id,
      nextContentRevision,
      row.isFaceProcessed || row.faceRefreshPending
    );
    return true;
  });
  if (accepted) {
    invalidateVectorSearch();
    scheduleRefresh(0);
    await publish(id);
  }
  return accepted;
}

export async function retryLibraryPhotoRefresh(
  id: number,
  mode: LibraryRefreshMode = "retry"
): Promise<boolean> {
  const requestedGeneration = generation;
  const db = getDatabase();
  const row = readPhoto(db, id);
  if (!row || row.deletedAt !== null || row.sourceStatus !== "available") {
    return false;
  }
  const accepted = await observeLibraryPhoto(id, row.path);
  const stat = await fs.stat(row.path).catch(() => null);
  const { requestAutoIndexPhotoRetry } = await import("./ai-index-scheduler");
  if (requestedGeneration !== generation || db !== getDatabase()) {
    return false;
  }
  const latest = readPhoto(db, id);
  if (
    !(stat?.isFile() && latest && sameFileState(latest, fileState(stat))) ||
    latest.path !== row.path ||
    latest.sourceStatus !== "available" ||
    latest.deletedAt !== null
  ) {
    return false;
  }
  const updated = db.transaction((tx) => {
    const job = tx
      .select()
      .from(libraryRefreshJobs)
      .where(eq(libraryRefreshJobs.photoId, id))
      .get();
    const phase = getRequestedPhase(mode, latest, job);
    const retryAi =
      mode === "analysis" ||
      (mode === "retry" &&
        (latest.embeddingRevision !== latest.contentRevision ||
          !latest.isAiProcessed ||
          latest.embeddingRefreshAttempts > 0 ||
          latest.faceRefreshPending));
    if (!(phase || retryAi || accepted)) {
      return false;
    }
    tx.update(photos)
      .set({
        ...(phase
          ? { refreshStatus: "pending" as const, refreshError: null }
          : {}),
        ...(retryAi
          ? {
              ...resetEmbeddingRefreshRetry,
              faceRefreshAttempts: 0,
              faceRefreshRetryAt: 0,
              faceProcessingError: null,
            }
          : {}),
        ...(mode === "analysis"
          ? {
              analysisGeneration: sql`${photos.analysisGeneration} + 1`,
              isAiProcessed: false,
              embeddingRevision: -1,
              colorRevision: -1,
              faceRefreshPending:
                latest.isFaceProcessed || latest.faceRefreshPending,
              isFaceProcessed: false,
            }
          : {}),
      })
      .where(stillCurrent(latest))
      .run();
    if (mode === "analysis") {
      tx.delete(advancedExifData).where(eq(advancedExifData.photoId, id)).run();
      tx.delete(photoTags)
        .where(
          and(
            eq(photoTags.photoId, id),
            eq(photoTags.origin, "auto"),
            eq(photoTags.userConfirmed, false)
          )
        )
        .run();
    }
    if (phase) {
      queueRefresh(
        tx,
        id,
        latest.contentRevision,
        phase,
        mode === "preview" || (job?.repairPreview ?? false)
      );
    }
    return { retryAi };
  });
  if (updated) {
    if (mode === "analysis") {
      invalidateVectorSearch();
    }
    if (updated.retryAi) {
      requestAutoIndexPhotoRetry(id);
    }
    scheduleRefresh(0);
    await publish(id);
  }
  return Boolean(updated);
}

function getRequestedPhase(
  mode: LibraryRefreshMode,
  photo: NonNullable<ReturnType<typeof readPhoto>>,
  job?: RefreshJob
): RefreshPhase | undefined {
  if (mode === "analysis") {
    return "metadata";
  }
  if (job?.contentRevision === photo.contentRevision) {
    if (mode === "preview" && job.phase === "color") {
      return "metadata";
    }
    if (
      job.requestId === 0 &&
      photo.metadataRevision === photo.contentRevision
    ) {
      // The old queue did not record the point at which SQLite committed.
      return "color";
    }
    return job.phase;
  }
  if (
    photo.metadataRevision !== photo.contentRevision ||
    photo.refreshStatus === "failed"
  ) {
    return "metadata";
  }
  if (photo.colorRevision !== photo.contentRevision) {
    return mode === "preview" ? "metadata" : "color";
  }
  return mode === "preview" ? "preview" : undefined;
}

function scheduleRefresh(delay: number): void {
  if (!running) {
    return;
  }
  clearTimeout(timer);
  timer = setTimeout(() => {
    timer = undefined;
    if (active) {
      scheduleRefresh(500);
      return;
    }
    active = drainRefresh(generation)
      .catch((err) => log.warn({ err }, "Photo refresh pass failed"))
      .finally(() => {
        active = undefined;
      });
  }, delay);
  timer.unref?.();
}

function nextRefresh() {
  const db = getDatabase();
  return db
    .select({ job: libraryRefreshJobs, row: photos })
    .from(libraryRefreshJobs)
    .innerJoin(photos, eq(photos.id, libraryRefreshJobs.photoId))
    .where(
      and(
        lt(libraryRefreshJobs.attempts, MAX_ATTEMPTS),
        eq(photos.sourceStatus, "available"),
        isNull(photos.deletedAt),
        eq(libraryRefreshJobs.contentRevision, photos.contentRevision)
      )
    )
    .orderBy(libraryRefreshJobs.retryAt, libraryRefreshJobs.photoId)
    .limit(1)
    .get();
}

async function drainRefresh(expectedGeneration: number): Promise<void> {
  const { isImportQueueBusy } = await import("./import-queue");
  if (expectedGeneration !== generation) {
    return;
  }
  if (isImportQueueBusy()) {
    scheduleRefresh(1000);
    return;
  }
  const next = nextRefresh();
  if (!next) {
    return;
  }
  const now = Date.now();
  if (next.job.retryAt > now) {
    scheduleRefresh(Math.min(5000, next.job.retryAt - now));
    return;
  }
  await refreshOne(next, expectedGeneration);
  if (expectedGeneration === generation) {
    scheduleRefresh(20);
  }
}

async function refreshOne(
  { job, row }: NonNullable<ReturnType<typeof nextRefresh>>,
  expectedGeneration: number
): Promise<void> {
  const db = getDatabase();
  const match = and(
    stillCurrent(row),
    eq(photos.analysisGeneration, row.analysisGeneration),
    exists(
      db
        .select({ id: libraryRefreshJobs.photoId })
        .from(libraryRefreshJobs)
        .where(jobMatch(job))
    )
  );
  const isCurrent = () =>
    expectedGeneration === generation &&
    db === getDatabase() &&
    Boolean(db.select({ id: photos.id }).from(photos).where(match).get());
  try {
    const { preparePhotoRecord } = await import("./indexer");
    const { deleteDuelPreview } = await import("./thumbnailer");
    if (!isCurrent()) {
      return;
    }
    const before = await fs.stat(row.path);
    if (!sameFileState(row, fileState(before))) {
      if (!(await observeLibraryPhoto(row.id, row.path))) {
        throw new Error("Source changed during refresh");
      }
      return;
    }
    if (job.phase === "color") {
      await publishColor(row);
      if (!isCurrent()) {
        return;
      }
      db.transaction((tx) => {
        tx.update(photos)
          .set({ refreshStatus: "ready", refreshError: null })
          .where(match)
          .run();
        tx.delete(libraryRefreshJobs).where(jobMatch(job)).run();
      });
      await publish(row.id);
      return;
    }
    if (job.phase === "metadata") {
      await deleteDuelPreview(row.path);
    }
    const prepared = await preparePhotoRecord(row.path, row.folderId, {
      repairPreview: job.phase === "preview" || job.repairPreview,
    });
    const after = await fs.stat(row.path);
    if (!isCurrent()) {
      return;
    }
    if (!sameFileState(row, fileState(after))) {
      if (!(await observeLibraryPhoto(row.id, row.path))) {
        throw new Error("Source changed during refresh");
      }
      return;
    }
    if (!prepared) {
      throw new Error("Source metadata could not be read");
    }
    const {
      colorBucket,
      colorSpace,
      dominantColors,
      fileDate,
      fileSize,
      format,
      hasAlpha,
      height,
      phash,
      thumbnailPath,
      thumbnailSize,
      width,
    } = prepared.photoRecord;
    const committed = db.transaction((tx) => {
      if (
        tx
          .update(photos)
          .set(
            job.phase === "preview"
              ? {
                  thumbnailPath,
                  thumbnailSize,
                  refreshStatus: "ready",
                  refreshError: null,
                }
              : {
                  colorBucket,
                  colorSpace,
                  dominantColors,
                  fileDate,
                  fileSize,
                  format,
                  hasAlpha,
                  height,
                  phash,
                  thumbnailPath,
                  thumbnailSize,
                  width,
                  metadataRevision: row.contentRevision,
                  refreshStatus: "pending",
                  refreshError: null,
                }
          )
          .where(match)
          .run().changes !== 1
      ) {
        return false;
      }
      if (job.phase === "preview") {
        tx.delete(libraryRefreshJobs).where(jobMatch(job)).run();
      } else {
        tx.delete(exifData).where(eq(exifData.photoId, row.id)).run();
        if (prepared.exifRecord) {
          tx.insert(exifData)
            .values({ ...prepared.exifRecord, photoId: row.id })
            .run();
        }
        tx.update(libraryRefreshJobs)
          .set({
            phase: "color",
            repairPreview: false,
            attempts: 0,
            retryAt: 0,
          })
          .where(jobMatch(job))
          .run();
      }
      return true;
    });
    if (committed) {
      await publishPreparedPhoto(job, row, thumbnailPath);
    }
  } catch (err) {
    if (!isCurrent()) {
      return;
    }
    const attempts = job.attempts + 1;
    db.transaction((tx) => {
      if (!tx.select({ id: photos.id }).from(photos).where(match).get()) {
        return;
      }
      tx.update(libraryRefreshJobs)
        .set({ attempts, retryAt: Date.now() + 1000 * 2 ** attempts })
        .where(jobMatch(job))
        .run();
      tx.update(photos)
        .set({
          refreshStatus: attempts >= MAX_ATTEMPTS ? "failed" : "pending",
          refreshError:
            err instanceof Error
              ? err.message.slice(0, 300)
              : "Photo refresh failed",
        })
        .where(match)
        .run();
    });
    log.warn(
      { err, photoId: row.id, attempts },
      "Photo refresh did not complete"
    );
    await publish(row.id);
  }
}

function jobMatch(job: RefreshJob) {
  return and(
    eq(libraryRefreshJobs.photoId, job.photoId),
    eq(libraryRefreshJobs.contentRevision, job.contentRevision),
    eq(libraryRefreshJobs.requestId, job.requestId)
  );
}

async function publishColor(row: typeof photos.$inferSelect): Promise<void> {
  if (row.dominantColors) {
    const { upsertColorVector } = await import("./ai/vector-db");
    const primary = (
      JSON.parse(row.dominantColors) as Array<{
        r: number;
        g: number;
        b: number;
      }>
    )[0];
    if (primary) {
      await upsertColorVector(
        row.id,
        primary.r,
        primary.g,
        primary.b,
        row.contentRevision,
        row.analysisGeneration
      );
      return;
    }
  }
  getDatabase()
    .update(photos)
    .set({ colorRevision: row.contentRevision })
    .where(
      and(
        stillCurrent(row),
        eq(photos.analysisGeneration, row.analysisGeneration)
      )
    )
    .run();
}

export function startLibraryContentRefresh(): void {
  running = true;
  recoverRefreshJobs();
  scheduleRefresh(0);
}

function recoverRefreshJobs(): void {
  const db = getDatabase();
  db.transaction((tx) => {
    tx.update(libraryRefreshJobs)
      .set({ phase: "color" })
      .where(
        and(
          eq(libraryRefreshJobs.requestId, 0),
          exists(
            tx
              .select({ id: photos.id })
              .from(photos)
              .where(
                and(
                  eq(photos.id, libraryRefreshJobs.photoId),
                  eq(
                    photos.contentRevision,
                    libraryRefreshJobs.contentRevision
                  ),
                  eq(photos.metadataRevision, photos.contentRevision)
                )
              )
          )
        )
      )
      .run();
    tx.update(photos)
      .set({ refreshStatus: "pending" })
      .where(
        and(
          eq(photos.refreshStatus, "ready"),
          exists(
            tx
              .select({ id: libraryRefreshJobs.photoId })
              .from(libraryRefreshJobs)
              .where(
                and(
                  eq(libraryRefreshJobs.photoId, photos.id),
                  eq(
                    libraryRefreshJobs.contentRevision,
                    photos.contentRevision
                  ),
                  lt(libraryRefreshJobs.attempts, MAX_ATTEMPTS)
                )
              )
          )
        )
      )
      .run();
    tx.run(
      sql.raw(
        "INSERT INTO library_refresh_jobs (photo_id, content_revision, phase, request_id) SELECT id, content_revision, 'color', 1 FROM photos WHERE deleted_at IS NULL AND metadata_revision = content_revision AND color_revision <> content_revision AND dominant_colors IS NOT NULL ON CONFLICT(photo_id) DO NOTHING"
      )
    );
  });
}

export function wakeLibraryContentRefresh(): void {
  scheduleRefresh(0);
}

export async function stopLibraryContentRefresh(): Promise<void> {
  running = false;
  generation++;
  clearTimeout(timer);
  timer = undefined;
  await active;
}

async function publishPreparedPhoto(
  job: RefreshJob,
  row: typeof photos.$inferSelect,
  thumbnailPath: string | null
) {
  if (thumbnailPath) {
    const { finishPreviewRepair } = await import("./thumbnailer");
    await finishPreviewRepair(row.path, thumbnailPath).catch(
      (error: unknown) => {
        log.warn({ error, photoId: row.id }, "Old preview cleanup deferred");
      }
    );
  }
  if (job.phase === "metadata") {
    const { scheduleAdvancedExifEnrichment } = await import("./advanced-exif");
    const { requestAutoIndex } = await import("./ai-index-scheduler");
    scheduleAdvancedExifEnrichment();
    requestAutoIndex("content-refresh");
  }
  await publish(row.id);
}
