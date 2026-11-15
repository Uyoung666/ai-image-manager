export const LIBRARY_SOURCE_STATUSES = [
  "unverified",
  "available",
  "offline",
  "missing",
  "inaccessible",
] as const;

export type LibrarySourceStatus = (typeof LIBRARY_SOURCE_STATUSES)[number];
export type LibraryRefreshStatus = "ready" | "pending" | "failed";
export type LibraryRefreshMode = "retry" | "preview" | "analysis";
export type LibraryStatusFilter = LibrarySourceStatus | "pending" | "failed";

export interface LibraryPhotoStatus {
  refreshError?: string | null;
  refreshStatus?: LibraryRefreshStatus;
  sourceAvailableAt?: number | null;
  sourceCheckedAt?: number | null;
  sourceErrorCode?: string | null;
  sourceStatus?: LibrarySourceStatus;
}
