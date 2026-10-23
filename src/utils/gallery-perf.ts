export interface GalleryPerfBucket {
  count: number;
  max: number;
  samples?: number[];
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

export function isGalleryPerfEnabled(): boolean {
  return (
    typeof window !== "undefined" &&
    (isDevRuntime() || window.electronAPI?.galleryPerfEnabled === true)
  );
}

export function recordGalleryPerf(name: string, value: number): void {
  if (!(isGalleryPerfEnabled() && Number.isFinite(value))) {
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
  const samples = bucket.samples ?? [];
  samples[(bucket.count - 1) % 2048] = value;
  bucket.samples = samples;
}

export function recordGalleryMediaStat(name: string, value = 1): void {
  const enabled =
    typeof window === "undefined"
      ? isDevRuntime() ||
        (typeof process !== "undefined" && process.env.AIM_GALLERY_PERF === "1")
      : isGalleryPerfEnabled();
  if (!enabled) {
    return;
  }
  const mediaGlobal = globalThis as GalleryMediaGlobal;
  const stats = mediaGlobal.__galleryMediaStats ?? {};
  mediaGlobal.__galleryMediaStats = stats;
  stats[name] = (stats[name] || 0) + value;
}

export function startGalleryPerfProbe(surface: HTMLElement): () => void {
  if (
    !isGalleryPerfEnabled() ||
    window.electronAPI?.galleryPerfEnabled !== true
  ) {
    return () => undefined;
  }
  let frame = 0;
  let previous = 0;
  let entered = performance.now();
  let firstViewport = false;
  let lastScroll = 0;
  let sampledScroll = 0;
  const scroll = () => {
    lastScroll = performance.now();
  };
  surface.addEventListener("scroll", scroll, { passive: true });
  const observer =
    typeof PerformanceObserver === "undefined"
      ? null
      : new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            recordGalleryPerf("longTaskMs", entry.duration);
          }
        });
  if (
    observer &&
    PerformanceObserver.supportedEntryTypes?.includes("longtask")
  ) {
    observer?.observe({ entryTypes: ["longtask"] });
  }
  const sample = (now: number) => {
    if (document.visibilityState === "visible") {
      if (previous > 0) {
        recordGalleryPerf("frameIntervalMs", now - previous);
      }
      const bounds = surface.getBoundingClientRect();
      const cards = [
        ...surface.querySelectorAll<HTMLElement>("[data-photo-id]"),
      ].filter((card) => {
        if (card.querySelector("[data-photo-id]")) {
          return false;
        }
        const rect = card.getBoundingClientRect();
        return (
          rect.width > 0 && rect.bottom > bounds.top && rect.top < bounds.bottom
        );
      });
      const images = cards.flatMap((card) => [
        ...card.querySelectorAll<HTMLImageElement>("img"),
      ]);
      const loaded = images.filter(
        (image) =>
          image.complete &&
          image.naturalWidth > 0 &&
          image.dataset.loadState !== "loading"
      ).length;
      const ratio = cards.length > 0 ? Math.min(1, loaded / cards.length) : 0;
      recordGalleryPerf("visiblePlaceholderRatio", 1 - ratio);
      if (!firstViewport && cards.length > 0 && ratio >= 0.8) {
        firstViewport = true;
        recordGalleryPerf("firstViewport80Ms", now - entered);
      }
      if (
        lastScroll > sampledScroll &&
        now - lastScroll >= 150 &&
        ratio >= 0.95
      ) {
        sampledScroll = lastScroll;
        recordGalleryPerf("scrollStop95Ms", now - lastScroll);
      }
    } else {
      entered = performance.now();
    }
    previous = now;
    frame = requestAnimationFrame(sample);
  };
  frame = requestAnimationFrame(sample);
  return () => {
    cancelAnimationFrame(frame);
    observer?.disconnect();
    surface.removeEventListener("scroll", scroll);
  };
}
