import type { Photo } from "./photo";

export type PhotoSequenceType = "burst" | "timelapse";

export interface SequenceOrderChange {
  orderedMemberIds: number[];
  sequenceId: number;
}

export interface SequenceChangeEvent {
  affectedSequenceIds?: number[];
  channel: "sequences-changed";
  deletedSequenceIds?: number[];
  folderId?: number;
  orderedMemberIds?: number[];
  reason:
    | "detection"
    | "manual"
    | "reorder"
    | "rebuild"
    | "restore"
    | "settings";
  replacementSequenceIds?: number[];
  revision: number;
  sequenceId?: number;
  version: number;
}

export interface SequenceSuggestionSegment {
  cameraModel: string;
  endedAt: number;
  firstPhoto: Photo;
  frameCount: number;
  id: number;
  intervalMs: number;
  lastPhoto: Photo;
  lensModel: string;
  representative: Photo;
  startedAt: number;
}

export interface SequenceSuggestion {
  first: SequenceSuggestionSegment;
  firstSequenceId: number;
  gapMs: number;
  id: number;
  reasonKeys: string[];
  second: SequenceSuggestionSegment;
  secondSequenceId: number;
}

export type AcceptSequenceSuggestionResult =
  | { status: "merged"; id: number; revision: number }
  | { status: "stale"; revision: number };

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
