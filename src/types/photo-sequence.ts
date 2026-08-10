import type { Photo } from "./photo";

export type PhotoSequenceType = "burst" | "timelapse";

export interface SequenceOrderChange {
  orderedMemberIds: number[];
  sequenceId: number;
}

export interface PhotoSequence {
  endedAt: number;
  frameCount: number;
  id: number;
  matchedCount?: number;
  matchedPhoto?: Photo;
  matchedPhotoIds?: number[];
  memberPhotoIds?: number[];
  photo: Photo;
  representativePhotoId: number | null;
  source: "auto" | "manual";
  startedAt: number;
  type: PhotoSequenceType;
  userLocked?: boolean;
}

export interface PhotoSequenceDetail {
  cameraModel?: string | null;
  endedAt: number;
  frameCount: number;
  id: number;
  lensModel?: string | null;
  members: Photo[];
  representativePhotoId: number | null;
  source: "auto" | "manual";
  startedAt: number;
  type: PhotoSequenceType;
  userLocked: boolean;
}
