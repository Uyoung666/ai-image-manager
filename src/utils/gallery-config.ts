/** Shared renderer/host budgets. Pixel tiers are physical pixels, independent of DPI. */
export const GALLERY_CONFIG = {
  imageConcurrency: 6,
  prefetchConcurrency: 2,
  imageTimeoutMs: 8000,
  scrollIdleMs: 150,
  validationCacheEntries: 4096,
  thumbnailDescriptorBatchSize: 200,
  pageThumbnailDescriptors: 24,
  maintenanceFileConcurrency: 2,
  generationConcurrency: 4,
  diskCheckIntervalMs: 5 * 60_000,
  initialDiskAuditDelayMs: 30_000,
  maxDiskFiles: 400_000,
  pageSize: 100,
  maxPages: 20,
  maxPhotoBytes: 16 * 1024 * 1024,
  maxContexts: 3,
  contextTtlMs: 5 * 60_000,
  layoutBlockSize: 1000,
  layoutWorkerThreshold: 5000,
} as const;

export const GALLERY_THUMBNAIL_EDGES = [256, 512, 1024, 2048] as const;
export type GalleryThumbnailEdge = (typeof GALLERY_THUMBNAIL_EDGES)[number];

export function chooseGalleryThumbnailEdge(
  width: number,
  height: number,
  dpr: number
): GalleryThumbnailEdge {
  const pixels = Math.max(width, height, 1) * Math.max(1, dpr || 1);
  return GALLERY_THUMBNAIL_EDGES.find((edge) => edge >= pixels) ?? 2048;
}
