import {
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  type BrowsePhoto,
  browseMedia,
  browseNeighborIndices,
  browsePhotoKey,
  browsePlaceholder,
  type ImageArea,
} from "@/utils/browse-image";
import {
  getGalleryDpr,
  subscribeGalleryDpr,
} from "@/utils/gallery-image-observer";
import { recordGalleryPerf } from "@/utils/gallery-perf";
import { isImageReady } from "@/utils/image-scheduler";

export function useBrowseArea(
  canvas?: RefObject<HTMLDivElement | null>,
  open = true
) {
  const [area, setArea] = useState<ImageArea>({ width: 0, height: 0 });
  const dpr = useSyncExternalStore(subscribeGalleryDpr, getGalleryDpr);
  useLayoutEffect(() => {
    if (!open) {
      return;
    }
    const element = canvas?.current;
    const measure = () => {
      if (element && element.clientWidth > 0 && element.clientHeight > 0) {
        const style = getComputedStyle(element);
        const px = (name: string) =>
          Number.parseFloat(style.getPropertyValue(name)) || 0;
        setArea({
          width: Math.max(
            0,
            element.clientWidth - px("padding-left") - px("padding-right")
          ),
          height: Math.max(
            0,
            element.clientHeight - px("padding-top") - px("padding-bottom")
          ),
        });
      } else {
        setArea({
          width: window.innerWidth * 0.9,
          height:
            window.innerHeight <= 560
              ? Math.max(1, window.innerHeight - 144)
              : window.innerHeight * 0.72,
        });
      }
    };
    measure();
    const observer =
      element && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(measure)
        : undefined;
    if (element) {
      observer?.observe(element);
    }
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [canvas, open]);
  return { area, dpr };
}

interface BrowseNavigation {
  direction: number;
  id: number | undefined;
  index: number;
  streak: number;
}

function trackNavigation(
  previous: BrowseNavigation,
  index: number,
  id: number,
  count: number,
  wrap: boolean
): BrowseNavigation {
  if (id === previous.id) {
    return { ...previous, index };
  }
  const delta = index - previous.index;
  let direction = Math.abs(delta) === 1 ? delta : 0;
  if (wrap && count > 2 && Math.abs(delta) === count - 1) {
    direction = delta < 0 ? 1 : -1;
  }
  return {
    index,
    id,
    direction,
    streak: direction === previous.direction ? previous.streak + 1 : 1,
  };
}

export function useBrowsePrefetch(
  photos: readonly BrowsePhoto[],
  index: number,
  area: ImageArea,
  dpr: number,
  enabled: boolean,
  wrap: boolean,
  currentReady = true
) {
  const navigation = useRef<BrowseNavigation>({
    index,
    id: photos[index]?.id,
    direction: 0,
    streak: 0,
  });
  const active = useRef<{ controller: AbortController; url: string } | null>(
    null
  );
  const requested = useRef(new Set<string>());
  const resume = useRef<(() => void) | null>(null);
  useEffect(() => () => active.current?.controller.abort(), []);
  useEffect(() => {
    const photo = photos[index];
    if (!(enabled && photo && area.width > 0 && area.height > 0)) {
      active.current?.controller.abort();
      active.current = null;
      requested.current.clear();
      navigation.current = { index, id: photo?.id, direction: 0, streak: 0 };
      return;
    }
    navigation.current = trackNavigation(
      navigation.current,
      index,
      photo.id,
      photos.length,
      wrap
    );
    const { direction, streak } = navigation.current;
    const current = browseMedia(photo, area, dpr).fit;
    const urls = browseNeighborIndices(
      photos.length,
      index,
      streak >= 2 ? direction : 0,
      wrap
    )
      .map((target) => browseMedia(photos[target], area, dpr))
      .filter((media) => media.prefetch)
      .map((media) => media.fit);
    const keep = new Set([current, ...urls]);
    if (active.current && !keep.has(active.current.url)) {
      active.current.controller.abort();
      active.current = null;
    }
    for (const url of requested.current) {
      if (!keep.has(url)) {
        requested.current.delete(url);
      }
    }
    function next() {
      if (active.current || !currentReady) {
        return;
      }
      const url = urls.find(
        (item) => !(requested.current.has(item) || isImageReady(item))
      );
      if (!url) {
        return;
      }
      requested.current.add(url);
      const controller = new AbortController();
      active.current = { controller, url };
      // Warm the on-disk variant. The foreground image can make its own
      // request and promote the same host job even while this fetch is pending.
      fetch(url, {
        cache: "no-store",
        signal: controller.signal,
        priority: "low",
      })
        .then((response) => (response.ok ? response.arrayBuffer() : undefined))
        .catch(() => undefined)
        .finally(() => {
          if (active.current?.controller === controller) {
            active.current = null;
          }
          resume.current?.();
        });
    }
    resume.current = next;
    next();
    return () => {
      resume.current = null;
    };
  }, [area, currentReady, dpr, enabled, index, photos, wrap]);
}

let recentBrowseImage: { key: string; url: string } | null = null;

/** Keep the last successful layer only while the exact source is still selected. */
export function useBrowsePlaceholder(
  photo: BrowsePhoto | undefined,
  src: string | null,
  loaded: boolean,
  fitSrc?: string
) {
  const last = useRef<{ key: string; url: string } | null>(null);
  const key = photo ? browsePhotoKey(photo) : "";
  useLayoutEffect(() => {
    if (loaded && src && src === fitSrc) {
      last.current = recentBrowseImage = { key, url: src };
    }
  }, [fitSrc, key, loaded, src]);
  if (!photo) {
    return null;
  }
  if (last.current?.key === key && last.current.url !== src) {
    return last.current.url;
  }
  if (
    recentBrowseImage?.key === key &&
    recentBrowseImage.url !== src &&
    isImageReady(recentBrowseImage.url)
  ) {
    return recentBrowseImage.url;
  }
  return browsePlaceholder(photo);
}

export function useBrowseTiming(key: string, visible: boolean, clear: boolean) {
  const timing = useRef({ key: "", start: 0, visible: false, clear: false });
  useLayoutEffect(() => {
    if (timing.current.key !== key) {
      timing.current = {
        key,
        start: performance.now(),
        visible: false,
        clear: false,
      };
    }
    if (visible && !timing.current.visible) {
      timing.current.visible = true;
      recordGalleryPerf(
        "browseFirstVisibleMs",
        performance.now() - timing.current.start
      );
    }
    if (clear && !timing.current.clear) {
      timing.current.clear = true;
      recordGalleryPerf(
        "browseClearMs",
        performance.now() - timing.current.start
      );
    }
  }, [clear, key, visible]);
}
