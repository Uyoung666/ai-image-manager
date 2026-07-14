export interface Photo {
  dominantColors?: string | null;
  fileDate?: number | null;
  filename: string;
  fileSize: number;
  height: number;
  id: number;
  isFavorite?: boolean;
  isIndexed: boolean;
  path: string;
  score?: number;
  similarity?: number;
  thumbnailSmallPath?: string | null;
  thumbnailPath: string | null;
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
  fallback?: "filename" | "tags";
  query?: string;
  results: Photo[];
  total: number;
}

export interface AiStatus {
  embeddingProgress: { processed: number; total: number; phase: string };
  hasVectors: boolean;
  indexReady: boolean;
  isEmbedding: boolean;
  lastError?: string;
  model: string;
  vectorCount: number;
  vectorDB: string;
}

export interface Tag {
  color: string | null;
  id: number;
  name: string;
  photoCount?: number;
}
