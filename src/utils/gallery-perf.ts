export interface GalleryPerfBucket {
  count: number;
  max: number;
  total: number;
}

type ImportMetaWithEnv = ImportMeta & {
  env?: {
    DEV?: boolean;
  };
};

type GalleryPerfWindow = Window & {
  __galleryPerf?: Record<string, GalleryPerfBucket>;
};

type GalleryMediaGlobal = typeof globalThis & {
  __galleryMediaStats?: Record<string, number>;
};

export function isDevRuntime(): boolean {
  return ((import.meta as ImportMetaWithEnv).env?.DEV ?? false) === true;
}

export function recordGalleryPerf(name: string, value: number): void {
  if (!isDevRuntime() || typeof window === "undefined") {
    return;
  }
  const perfWindow = window as GalleryPerfWindow;
  const perf = perfWindow.__galleryPerf ?? {};
  perfWindow.__galleryPerf = perf;
  const bucket = perf[name] ?? {
    count: 0,
    max: 0,
    total: 0,
  };
  perf[name] = bucket;
  bucket.count++;
  bucket.total += value;
  bucket.max = Math.max(bucket.max, value);
}

export function recordGalleryMediaStat(name: string): void {
  if (
    typeof process !== "undefined" &&
    process.env.NODE_ENV === "production"
  ) {
    return;
  }
  const mediaGlobal = globalThis as GalleryMediaGlobal;
  const stats = mediaGlobal.__galleryMediaStats ?? {};
  mediaGlobal.__galleryMediaStats = stats;
  stats[name] = (stats[name] || 0) + 1;
}
