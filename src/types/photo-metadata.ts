export type AdvancedExifStatus =
  | "pending"
  | "processing"
  | "complete"
  | "partial"
  | "failed"
  | "unsupported";

export type ProvenanceStatus =
  | "present_unverified"
  | "not_detected"
  | "unknown";

export const PROVENANCE_STATUSES: readonly ProvenanceStatus[] = [
  "present_unverified",
  "not_detected",
  "unknown",
];

export interface PhotoProvenance {
  generator?: string | null;
  legacy?: boolean;
  status: ProvenanceStatus;
}

export const CONTENT_CREDENTIALS_PARSER_VERSION = 4;

const CREDENTIAL_FORMAT = /^(?:jpe?g|png|webp|heic|heif|avif|tiff?|dng)$/i;

export function supportsContentCredentialVerification(format: string): boolean {
  return CREDENTIAL_FORMAT.test(format);
}

export type CredentialCheck = "passed" | "failed" | "unknown";

export type SavedContentCredentialVerification =
  | {
      status: "checked";
      signature: CredentialCheck;
      binding: CredentialCheck;
      trust: CredentialCheck;
    }
  | { status: "no_credential" | "remote" };

export type ContentCredentialVerification =
  | SavedContentCredentialVerification
  | {
      status: "unsupported" | "unavailable" | "file_changed" | "busy" | "error";
    };

export interface MetadataSection {
  [key: string]: boolean | number | string | null | undefined;
}

export interface PhotoMetadata {
  autofocus: MetadataSection;
  capture: MetadataSection;
  processing: MetadataSection;
  provenance: PhotoProvenance;
  standard: MetadataSection;
  vendor: string | null;
  vendorRaw: Record<string, unknown>;
  workflow: MetadataSection;
}

export interface AdvancedExifProgress {
  failed: number;
  paused: boolean;
  processed: number;
  running: boolean;
  total: number;
}
