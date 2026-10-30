export type ShootingProjectSourceStatus = "online" | "offline" | "inaccessible";
export type ShootingProjectWorkflow = "curate" | "duel" | "hybrid";

export type ShootingProjectPhotoStatus =
  | "pending"
  | "undecided"
  | "kept"
  | "rejected";

export interface ShootingProject {
  archivedAt: number | null;
  coverPhotoId?: string | null;
  createdAt: number;
  id: string;
  keptCount: number;
  lastOpenedAt: number;
  name: string;
  outputIncomplete?: boolean;
  photoCount: number;
  pkMode?: "quick" | "standard" | "fine";
  previewReadyCount: number;
  scanStatus?: ShootingProjectScanStatus;
  sourceCheckedAt: number;
  sourceInLibrary: boolean;
  sourceRoot: string;
  sourceStatus: ShootingProjectSourceStatus;
  updatedAt: number;
  workflow: ShootingProjectWorkflow;
}

export type ShootingProjectScanStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "interrupted";
export type ShootingProjectFileStatus =
  | "unverified"
  | "available"
  | "missing"
  | "inaccessible"
  | "changed";

export interface ShootingProjectPhoto {
  dateTaken: number | null;
  filename: string;
  fileSize: number;
  format: string;
  height: number | null;
  id: string;
  modifiedAt: number;
  previewError: string | null;
  previewHeight: number | null;
  previewStatus: "pending" | "ready" | "failed";
  previewWidth: number | null;
  projectId: string;
  relativePath: string;
  sourceStatus: ShootingProjectFileStatus;
  status: ShootingProjectPhotoStatus;
  width: number | null;
}

export interface ShootingProjectBrowseState {
  currentPhotoId: string | null;
  filter: "all" | ShootingProjectPhotoStatus;
  format: string;
  gridScrollTop: number;
  orderedPhotoIds: string[];
  sort: "time" | "name" | "format";
  view: "single" | "grid";
}

export interface ShootingProjectWorkspaceData {
  browsing: ShootingProjectBrowseState;
  canUndo: boolean;
  counts: {
    pending: number;
    undecided: number;
    kept: number;
    rejected: number;
    reviewed: number;
    decided: number;
    allDecided: boolean;
  };
  photos: ShootingProjectPhoto[];
  previewBytes: number;
  project: ShootingProject;
  scan: {
    status: ShootingProjectScanStatus;
    kind: "initial" | "incremental";
    discovered: number;
    errors: { relativePath: string; code: string }[];
  };
}

export interface ShootingProjectRelinkInspection {
  candidates: number;
  changed: number;
  insufficient: number;
  items: {
    photoId: string;
    relativePath: string;
    status: "verified" | "candidate" | "missing" | "changed" | "insufficient";
  }[];
  missing: number;
  sourceRoot: string;
  token: string;
  verified: number;
}

export interface ShootingProjectOutputItem {
  copiedBytes: number;
  error: string | null;
  fileSize: number;
  id: string;
  kind: "original" | "xmp";
  photoId: string;
  relativePath: string;
  sha256: string | null;
  sourcePath: string;
  status:
    | "pending"
    | "copying"
    | "verifying"
    | "committing"
    | "completed"
    | "failed"
    | "cancelled";
  targetPath: string;
}

export interface ShootingProjectOutputTask {
  completedAt: number | null;
  createdAt: number;
  id: string;
  items: ShootingProjectOutputItem[];
  projectId: string;
  status:
    | "pending"
    | "running"
    | "completed"
    | "failed"
    | "cancelled"
    | "interrupted";
  targetRoot: string;
}

export interface ShootingProjectOutputInspection {
  bytes: number;
  count: number;
  originalCount: number;
  targetRoot: string;
  unavailable: number;
  watched: boolean;
  xmpCount: number;
}

export interface ShootingProjectLibraryRequest {
  photoIds?: string[];
  projectId: string;
  source: "original" | "output";
  taskId?: string;
}

export interface ShootingProjectSource {
  defaultName: string;
  sourceInLibrary: boolean;
  sourceRoot: string;
  sourceStatus: ShootingProjectSourceStatus;
}

export interface CreateShootingProjectInput {
  acknowledgeLibrarySource?: boolean;
  name?: string;
  pkMode?: "quick" | "standard" | "fine";
  sourceRoot: string;
  workflow?: ShootingProjectWorkflow;
}
