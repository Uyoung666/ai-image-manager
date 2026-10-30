export interface CullAvailability {
  projectId: string;
  reason:
    | "scanning"
    | "previews"
    | "empty"
    | "offline"
    | "failed"
    | "insufficient";
  unavailable: number;
}

export type CullPhotoSource =
  | { kind: "library"; photoId: number }
  | { kind: "project"; projectId: string; photoId: string };

export type ProjectCullScope =
  | { kind: "all" }
  | { kind: "selected"; photoIds: string[] };

export interface StartProjectCullInput {
  mode: "curate" | "duel";
  pkMode?: "quick" | "standard" | "fine";
  projectId: string;
  reuseExisting?: boolean;
  scope?: ProjectCullScope;
  sortStrategy?: "time" | "similarity";
}

export interface CullPhoto {
  duelPreviewPath?: string | null;
  fileDate: number | null;
  filename: string;
  fileSize: number;
  format: string;
  height: number;
  /** Display identity only. All mutations use the containing sessionPhotoId. */
  id: number;
  isFavorite: boolean | null;
  isIndexed: boolean;
  originalUrl?: string | null;
  path: string;
  previewHeight?: number | null;
  previewUrl?: string;
  previewWidth?: number | null;
  projectPhotoId?: string;
  source?: CullPhotoSource;
  thumbnailPath: string | null;
  width: number;
}

export type CullArchiveTask = { name: string; archivedAt?: number | null } & (
  | { kind: "project"; id: string }
  | { kind: "library"; id: number }
);

export interface CullTaskStage {
  comparisons: number;
  mode: "curate" | "duel";
  processedCount: number;
  progress: number;
  round?: number;
  status: "active" | "completed" | "not-started";
  totalPhotos: number;
}

export type CullTaskSummary = CullArchiveTask & {
  createdAt: number;
  workflow: "curate" | "duel" | "hybrid";
  photoCount: number;
  keptCount: number;
  stages: CullTaskStage[];
  outputStatus?:
    | "pending"
    | "running"
    | "completed"
    | "failed"
    | "cancelled"
    | "interrupted";
  sourceStatus?: "online" | "offline" | "inaccessible";
  scanStatus?: "pending" | "running" | "completed" | "failed" | "interrupted";
};
