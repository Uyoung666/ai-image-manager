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
  thumbnailPath: string | null;
  width: number;
}

export interface Folder {
  displayName: string;
  id: number;
  parentId: number | null;
  path: string;
  photoCount: number;
  totalPhotoCount?: number;
}

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
