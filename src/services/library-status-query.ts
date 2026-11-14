import { eq, sql } from "drizzle-orm";
import { photos } from "@/db/schema";
import type {
  LibraryRefreshStatus,
  LibraryStatusFilter,
} from "@/types/library-reliability";
import { embeddingRefreshFailed } from "./ai/embedding-refresh-retries";

export const libraryRefreshStatus = sql<LibraryRefreshStatus>`CASE
  WHEN ${photos.refreshStatus} = 'failed' OR ${embeddingRefreshFailed} OR (${photos.faceRefreshPending} = 1 AND ${photos.faceRefreshAttempts} >= 4 AND ${photos.faceProcessingError} IS NOT NULL) THEN 'failed'
  WHEN ${photos.refreshStatus} = 'ready' AND (${photos.embeddingRevision} <> ${photos.contentRevision} OR ${photos.faceRefreshPending} = 1) THEN 'pending'
  ELSE ${photos.refreshStatus} END`;

export const libraryStatusColumns = {
  sourceStatus: photos.sourceStatus,
  sourceAvailableAt: photos.sourceAvailableAt,
  sourceCheckedAt: photos.sourceCheckedAt,
  sourceErrorCode: photos.sourceErrorCode,
  refreshStatus: libraryRefreshStatus,
  refreshError: sql<string | null>`CASE
    WHEN ${photos.refreshStatus} = 'failed' THEN ${photos.refreshError}
    WHEN ${photos.faceRefreshPending} = 1 AND ${photos.faceRefreshAttempts} >= 4 AND ${photos.faceProcessingError} IS NOT NULL THEN ${photos.faceProcessingError}
    WHEN ${embeddingRefreshFailed} THEN 'EMBEDDING_REFRESH_FAILED'
    ELSE ${photos.refreshError} END`,
};

export function libraryStatusPredicate(status: LibraryStatusFilter) {
  return status === "pending" || status === "failed"
    ? eq(libraryRefreshStatus, status)
    : eq(photos.sourceStatus, status);
}
