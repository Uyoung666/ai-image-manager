import type { Photo } from "./photo";

export type PhotoSequenceType = "burst" | "timelapse";

export interface PhotoSequence {
  endedAt: number;
  frameCount: number;
  id: number;
  matchedCount?: number;
  memberPhotoIds?: number[];
  photo: Photo;
  representativePhotoId: number | null;
  source: "auto" | "manual";
  startedAt: number;
  type: PhotoSequenceType;
}

export interface PhotoSequenceDetail {
  members: Photo[];
}
