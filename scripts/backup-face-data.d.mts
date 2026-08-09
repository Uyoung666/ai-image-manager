export interface FaceBackupPayload {
  backupOf: string;
  checksum?: string;
  createdAt: number;
  faceIdentities: Record<string, unknown>[];
  faceIdentityMembers: Record<string, unknown>[];
  faceModelKind: string | null;
  faceProcessedPhotoIds: number[];
  faceVectors: Record<string, unknown>[];
  format: string;
  version: number;
  [key: string]: unknown;
}

export const FACE_BACKUP_FORMAT: string;
export const FACE_BACKUP_VERSION: number;

export function addFaceBackupChecksum(
  payload: Record<string, unknown>
): FaceBackupPayload;

export function validateFaceBackupPayload(
  payload: unknown,
  options?: { legacyKind?: string }
): unknown;

export function readFaceBackup(
  backupFile: string,
  options?: { legacyKind?: string }
): FaceBackupPayload;
