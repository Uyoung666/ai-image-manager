import { and, eq, gte, isNotNull, sql } from "drizzle-orm";
import { getDatabase } from "@/db";
import { photos } from "@/db/schema";
import {
  aiSourceReady,
  type PhotoWorkVersion,
  photoWorkVersionColumns,
  photoWorkVersionMatch,
} from "./photo-version";

export const EMBEDDING_MAX_ATTEMPTS = 4;

export const embeddingRefreshFailed = and(
  eq(photos.isAiProcessed, false),
  isNotNull(photos.embeddingRefreshFileRevision),
  eq(photos.embeddingRefreshFileRevision, photos.fileRevision),
  gte(photos.embeddingRefreshAttempts, EMBEDDING_MAX_ATTEMPTS)
);

export const resetEmbeddingRefreshRetry = {
  embeddingRefreshAttempts: 0,
  embeddingRefreshFileRevision: null,
  embeddingRefreshRetryAt: 0,
};

type RefreshDatabase = ReturnType<typeof getDatabase>;
interface EmbeddingRetryState {
  attempts: number;
  retryAt: number;
  retryFileRevision: number | null;
}

type EmbeddingRetryRow = PhotoWorkVersion & EmbeddingRetryState;

const pendingEmbedding = and(aiSourceReady, eq(photos.isAiProcessed, false));
const retryColumns = {
  attempts: photos.embeddingRefreshAttempts,
  retryAt: photos.embeddingRefreshRetryAt,
  retryFileRevision: photos.embeddingRefreshFileRevision,
};

export const embeddingRetryStateColumns = {
  ...photoWorkVersionColumns,
  ...retryColumns,
};

function attemptsForCurrentFile(
  row: EmbeddingRetryState & { fileRevision: number }
): number {
  return row.retryFileRevision === row.fileRevision ? row.attempts : 0;
}

export function planEmbeddingRetries(db: RefreshDatabase, now: number) {
  const rows = db
    .select({
      id: photos.id,
      fileRevision: photos.fileRevision,
      ...retryColumns,
    })
    .from(photos)
    .where(pendingEmbedding)
    .all();
  const excludePhotoIds = new Set<number>();
  let failedPhotoCount = 0;
  let retryAt = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    const attempts = attemptsForCurrentFile(row);
    if (attempts >= EMBEDDING_MAX_ATTEMPTS) {
      failedPhotoCount++;
    } else if (attempts > 0 && row.retryAt > now) {
      retryAt = Math.min(retryAt, row.retryAt);
    } else {
      continue;
    }
    excludePhotoIds.add(row.id);
  }
  return {
    excludePhotoIds,
    failedPhotoCount,
    hasWork: rows.length > excludePhotoIds.size,
    retryAt: Number.isFinite(retryAt) ? retryAt : undefined,
  };
}

export function recordEmbeddingFailures(
  db: RefreshDatabase,
  failedRows: readonly EmbeddingRetryRow[],
  now: number
) {
  if (!failedRows.length || db !== getDatabase()) {
    return { newlyExhausted: 0, retryAt: undefined };
  }
  return db.transaction((tx) => {
    let newlyExhausted = 0;
    let retryAt = Number.POSITIVE_INFINITY;
    for (const row of failedRows) {
      const attempts = attemptsForCurrentFile(row) + 1;
      if (attempts > EMBEDDING_MAX_ATTEMPTS) {
        continue;
      }
      const exhausted = attempts === EMBEDDING_MAX_ATTEMPTS;
      const nextRetryAt = exhausted ? 0 : now + 1000 * 2 ** attempts;
      const result = tx
        .update(photos)
        .set({
          embeddingRefreshAttempts: attempts,
          embeddingRefreshFileRevision: row.fileRevision,
          embeddingRefreshRetryAt: nextRetryAt,
        })
        .where(
          and(
            photoWorkVersionMatch(row),
            eq(photos.isAiProcessed, false),
            eq(photos.embeddingRefreshAttempts, row.attempts),
            eq(photos.embeddingRefreshRetryAt, row.retryAt),
            sql`${photos.embeddingRefreshFileRevision} IS ${row.retryFileRevision}`
          )
        )
        .run();
      if (result.changes === 0) {
        continue;
      }
      if (exhausted) {
        newlyExhausted++;
      } else {
        retryAt = Math.min(retryAt, nextRetryAt);
      }
    }
    return {
      newlyExhausted,
      retryAt: Number.isFinite(retryAt) ? retryAt : undefined,
    };
  });
}
