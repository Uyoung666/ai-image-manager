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

export interface MetadataSection {
  [key: string]: boolean | number | string | null | undefined;
}

export interface PhotoMetadata {
  autofocus: MetadataSection;
  capture: MetadataSection;
  processing: MetadataSection;
  provenance: MetadataSection & {
    issuer?: string | null;
    status: ProvenanceStatus;
  };
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
