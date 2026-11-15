import { and, eq, gt, gte, inArray, isNull, lt, lte } from "drizzle-orm";
import { getDatabase } from "@/db";
import { photos } from "@/db/schema";
import { aiSourceReady } from "./ai/photo-version";
import { resolveFaceScanFolderIds } from "./face-scan-scope";
import { getSetting } from "./settings-manager";

const MAX_ATTEMPTS = 4;
type RefreshDatabase = ReturnType<typeof getDatabase>;
interface FaceRefreshRow {
  analysisGeneration: number;
  attempts: number;
  error: string | null;
  fileRevision: number;
  id: number;
  retryAt: number;
  revision: number;
}

function retryableFaces(folderIds: number[]) {
  return and(
    aiSourceReady,
    eq(photos.faceRefreshPending, true),
    lt(photos.faceRefreshAttempts, MAX_ATTEMPTS),
    inArray(photos.folderId, folderIds)
  );
}

function currentAttempt(row: FaceRefreshRow, attempts: number) {
  return and(
    eq(photos.id, row.id),
    eq(photos.contentRevision, row.revision),
    eq(photos.fileRevision, row.fileRevision),
    eq(photos.analysisGeneration, row.analysisGeneration),
    eq(photos.faceRefreshAttempts, attempts),
    eq(photos.faceRefreshPending, true)
  );
}

function claimFaceRefresh(db: RefreshDatabase, rows: FaceRefreshRow[]) {
  return db.transaction(() =>
    rows.filter(
      (row) =>
        db
          .update(photos)
          .set({
            faceRefreshAttempts: row.attempts + 1,
            faceRefreshRetryAt: Date.now() + 1000 * 2 ** (row.attempts + 1),
            faceProcessingError: null,
          })
          .where(and(currentAttempt(row, row.attempts), aiSourceReady))
          .run().changes === 1
    )
  );
}

function finishFaceRefresh(
  db: RefreshDatabase,
  rows: FaceRefreshRow[],
  cancelled: boolean,
  error?: unknown
): void {
  for (const row of rows) {
    const current = db
      .select()
      .from(photos)
      .where(currentAttempt(row, row.attempts + 1))
      .get();
    if (!current) {
      continue;
    }
    const unavailable =
      current.deletedAt !== null ||
      !["available", "unverified"].includes(current.sourceStatus) ||
      current.metadataRevision !== current.contentRevision;
    const changes =
      cancelled || unavailable
        ? {
            faceRefreshAttempts: row.attempts,
            faceRefreshRetryAt: row.retryAt,
            faceProcessingError: row.error,
          }
        : {
            faceRefreshRetryAt: Date.now() + 1000 * 2 ** (row.attempts + 1),
            faceProcessingError:
              error instanceof Error
                ? error.message.slice(0, 300)
                : current.faceProcessingError || "FACE_REFRESH_FAILED",
          };
    db.update(photos)
      .set(changes)
      .where(currentAttempt(row, row.attempts + 1))
      .run();
  }
}

function isStopped(signal: AbortSignal, db: RefreshDatabase): boolean {
  return (
    signal.aborted ||
    db !== getDatabase() ||
    getSetting("faces.autoRefreshStopped") === "true"
  );
}

async function recoverExhaustedFaceRefresh(
  db: RefreshDatabase,
  folderIds: number[]
): Promise<void> {
  const recovered = db
    .update(photos)
    .set({ faceProcessingError: "FACE_REFRESH_INTERRUPTED" })
    .where(
      and(
        aiSourceReady,
        eq(photos.faceRefreshPending, true),
        gte(photos.faceRefreshAttempts, MAX_ATTEMPTS),
        isNull(photos.faceProcessingError),
        inArray(photos.folderId, folderIds)
      )
    )
    .run();
  if (recovered.changes) {
    const { notifyLibraryChange } = await import("./library-change");
    notifyLibraryChange(null, "status");
  }
}

async function processFaceBatch(
  db: RefreshDatabase,
  rows: FaceRefreshRow[],
  signal: AbortSignal
): Promise<boolean> {
  const { detectFaces, cancelFaceDetection, isFaceDetectionRunning } =
    await import("./face-detector");
  if (isStopped(signal, db) || isFaceDetectionRunning()) {
    return false;
  }
  const claimed = claimFaceRefresh(db, rows);
  const abort = () => cancelFaceDetection();
  signal.addEventListener("abort", abort, { once: true });
  let failure: unknown;
  try {
    await detectFaces(claimed.map(({ id }) => id));
  } catch (error) {
    failure = error;
  } finally {
    signal.removeEventListener("abort", abort);
  }
  if (db !== getDatabase()) {
    return false;
  }
  // Successful results clear their marker in the detector. Remaining rows also
  // cover per-photo worker errors and a missing model that returned no result.
  finishFaceRefresh(db, claimed, isStopped(signal, db), failure);
  const { notifyLibraryChange } = await import("./library-change");
  if (claimed.length) {
    notifyLibraryChange(null, "status");
  }
  return !isStopped(signal, db);
}

/** Return the next durable retry deadline for the existing AI scheduler. */
export async function refreshChangedPhotoFaces(
  signal: AbortSignal
): Promise<number | undefined> {
  const db = getDatabase();
  const folderIds = resolveFaceScanFolderIds();
  if (isStopped(signal, db) || !folderIds.length) {
    return;
  }
  await recoverExhaustedFaceRefresh(db, folderIds);
  let cursor = 0;
  while (!isStopped(signal, db)) {
    const rows = db
      .select({
        analysisGeneration: photos.analysisGeneration,
        id: photos.id,
        revision: photos.contentRevision,
        fileRevision: photos.fileRevision,
        attempts: photos.faceRefreshAttempts,
        error: photos.faceProcessingError,
        retryAt: photos.faceRefreshRetryAt,
      })
      .from(photos)
      .where(
        and(
          retryableFaces(folderIds),
          gt(photos.id, cursor),
          lte(photos.faceRefreshRetryAt, Date.now())
        )
      )
      .orderBy(photos.id)
      .limit(200)
      .all();
    if (!rows.length) {
      break;
    }
    cursor = rows.at(-1)?.id ?? cursor;
    if (!(await processFaceBatch(db, rows, signal))) {
      return;
    }
  }
  if (isStopped(signal, db)) {
    return;
  }
  return db
    .select({ retryAt: photos.faceRefreshRetryAt })
    .from(photos)
    .where(retryableFaces(folderIds))
    .orderBy(photos.faceRefreshRetryAt)
    .limit(1)
    .get()?.retryAt;
}
