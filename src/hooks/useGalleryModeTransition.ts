import { type RefObject, useEffect, useRef } from "react";
import { scheduleImage } from "@/utils/image-scheduler";

type GalleryMode = "photos" | "sequences";
const MAX_RESTORE_IMAGES = 64;
const RESTORE_CONCURRENCY = 4;
const RESTORE_TIMEOUT_MS = 1500;
const SOURCE_DESCRIPTOR_SEPARATOR = /\s+/;

function visibleImageSources(surface: HTMLElement | null): string[] {
  const scroll = surface?.querySelector("[data-masonry-scroll]");
  if (!scroll) {
    return [];
  }
  const bounds = scroll.getBoundingClientRect();
  const sources = new Set<string>();
  for (const image of scroll.querySelectorAll("img")) {
    const rect = image.getBoundingClientRect();
    if (
      rect.width <= 0 ||
      rect.height <= 0 ||
      rect.bottom <= bounds.top ||
      rect.top >= bounds.bottom ||
      rect.right <= bounds.left ||
      rect.left >= bounds.right
    ) {
      continue;
    }
    // Keep both responsive candidates so resizing the sequence view does not
    // restore photos with a cold thumbnail at the new device scale.
    for (const source of [
      image.currentSrc,
      image.src,
      ...image.srcset
        .split(",")
        .map((entry) => entry.trim().split(SOURCE_DESCRIPTOR_SEPARATOR)[0]),
    ]) {
      if (source && sources.size < MAX_RESTORE_IMAGES) {
        sources.add(source);
      }
    }
  }
  return [...sources];
}

function decodeImage(source: string, signal: AbortSignal): Promise<void> {
  return scheduleImage(source, {
    signal,
    priority: 0,
    consumer: "mode-restore",
  }).promise.then(() => undefined);
}

async function prepareImages(sources: string[], signal: AbortSignal) {
  const preparation = new AbortController();
  const abort = () => preparation.abort();
  signal.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, RESTORE_TIMEOUT_MS);
  let next = 0;
  try {
    await Promise.all(
      Array.from(
        { length: Math.min(RESTORE_CONCURRENCY, sources.length) },
        async () => {
          while (next < sources.length && !preparation.signal.aborted) {
            const source = sources[next++];
            await decodeImage(source, preparation.signal);
          }
        }
      )
    );
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
  }
}

/** Keep the current mode visible until the returning viewport can be painted. */
export function useGalleryModeTransition({
  currentMode,
  nextMode,
  onCommit,
  renderedScopeKey,
  scopeKey,
  surfaceRef,
}: {
  currentMode: GalleryMode;
  nextMode: GalleryMode;
  onCommit: (mode: GalleryMode) => void;
  renderedScopeKey: string;
  scopeKey: string;
  surfaceRef: RefObject<HTMLElement | null>;
}) {
  const remembered = useRef({
    scopeKey,
    photos: [] as string[],
    sequences: [] as string[],
  });

  useEffect(() => {
    if (remembered.current.scopeKey !== scopeKey) {
      remembered.current = { scopeKey, photos: [], sequences: [] };
    }
    if (currentMode === nextMode) {
      return;
    }
    if (renderedScopeKey === scopeKey) {
      remembered.current[currentMode] = visibleImageSources(surfaceRef.current);
    }
    const sources = remembered.current[nextMode];
    if (sources.length === 0) {
      onCommit(nextMode);
      return;
    }
    const controller = new AbortController();
    prepareImages(sources, controller.signal).then(() => {
      if (!controller.signal.aborted) {
        onCommit(nextMode);
      }
    });
    return () => controller.abort();
  }, [currentMode, nextMode, onCommit, renderedScopeKey, scopeKey, surfaceRef]);
}
