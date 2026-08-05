export type SearchMatch =
  | { kind: "color"; score: number }
  | { kind: "exact"; source: "filename" | "person" | "tag" }
  | {
      kind: "hybrid";
      evidence: ("semantic" | "tag")[];
      tagNames: string[];
      /** 语义证据存在时的余弦相似度（用于归一化角标百分比） */
      score?: number;
    }
  | { kind: "tagFilter"; origin: "manual" | "auto" }
  | { kind: "image"; score: number }
  | { kind: "semantic"; score: number };

export interface Photo {
  dominantColors?: string | null;
  fileDate?: number | null;
  filename: string;
  fileSize: number;
  height: number;
  id: number;
  isFavorite?: boolean;
  isIndexed: boolean;
  /** Search-result display metadata. Ranking scores stay internal to search. */
  match?: SearchMatch;
  path: string;
  score?: number;
  thumbnailPath: string | null;
  thumbnailSmallPath?: string | null;
  width: number;
}

export interface Folder {
  appearanceColor?: string | null;
  appearanceIcon?: FolderAppearanceIcon | null;
  displayName: string;
  id: number;
  parentId: number | null;
  path: string;
  photoCount: number;
  totalPhotoCount?: number;
}

export type FolderAppearanceIcon =
  import("@/lib/folder-appearance").FolderAppearanceIcon;

export interface PhotoListResponse {
  items: Photo[];
  limit: number;
  offset: number;
  total: number;
}

export interface SearchResponse {
  cursorExpired?: boolean;
  fallback?: "filename" | "tags";
  hasMore?: boolean;
  nextCursor?: string | null;
  nextOffset?: number | null;
  query?: string;
  results: Photo[];
  semantic?: {
    candidateDepth?: number;
    autoTagRescued?: number;
    consensusCutoff?: number;
    cutoffReason?: string;
    finalCutoff?: number;
    hasMore?: boolean;
    indexedPhotos: number;
    searchSessionHit?: boolean;
    intent?: "object" | "scene" | "composed" | "unknown";
    promptGroupCount?: number;
    ignoredLowConfidenceTags?: number;
    manualExactAccepted?: number;
    reason?: string;
    rejectedWeak?: number;
    state: "ready" | "partial" | "unavailable" | "error";
    strongAccepted?: number;
    strongCutoff?: number;
    semanticOnlyAccepted?: number;
    supportCutoff?: number;
    supportedAccepted?: number;
    tagSupportedAccepted?: number;
    topSimilarity?: number;
    totalPhotos: number;
    used: boolean;
  };
  snapshotVersion?: string;
  timeFilter?: {
    dateFrom: string;
    dateTo: string;
  };
  total: number;
  totalExact?: boolean;
}

export interface AiStatus {
  coverageState: "ready" | "partial" | "unavailable" | "error";
  embeddingProgress: { processed: number; total: number; phase: string };
  hasVectors: boolean;
  indexedPhotos: number;
  indexReady: boolean;
  isEmbedding: boolean;
  lastError?: string;
  model: string;
  pendingPhotos: number;
  totalPhotos: number;
  translationState?: "ready" | "loading" | "degraded" | "error";
  vectorCount: number;
  vectorDB: string;
}

export interface Tag {
  color: string | null;
  id: number;
  name: string;
  photoCount?: number;
}
