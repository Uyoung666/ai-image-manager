import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { chooseGalleryThumbnailEdge } from "@/utils/gallery-config";
import { requestThumbnailVersion } from "@/utils/gallery-thumbnail-descriptors";
import {
  type ImagePriority,
  isImageReady,
  scheduleImage,
} from "@/utils/image-scheduler";
import { toGalleryThumbnailUrl } from "@/utils/local-media-url";

const measured = new Map<
  string,
  { width: number; height: number; dpr: number; sourceVersion?: string }
>();

/** Keep the last decoded image while a new size is prepared. No Blob cache. */
export function useGalleryThumbnail({
  id,
  version,
  sourceVersion,
  width,
  height,
  enabled,
  priority = 0,
  generation,
}: {
  id: number;
  version: string;
  sourceVersion?: string;
  width: number;
  height: number;
  enabled: boolean;
  priority?: ImagePriority;
  generation?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const measurementKey = `${id}:${version}:${window.devicePixelRatio}`;
  const [geometry, setGeometry] = useState(
    () =>
      measured.get(measurementKey) ?? {
        width: 0,
        height: 0,
        dpr: window.devicePixelRatio || 1,
      }
  );
  const [visible, setVisible] = useState(false);
  const [descriptor, setDescriptor] = useState(() => ({
    id,
    version,
    ready: Boolean(
      sourceVersion || measured.get(measurementKey)?.sourceVersion
    ),
    value: sourceVersion ?? measured.get(measurementKey)?.sourceVersion,
  }));
  useEffect(() => {
    if (!enabled || sourceVersion) {
      return;
    }
    let current = true;
    requestThumbnailVersion(id).then((value) => {
      if (!current) {
        return;
      }
      setDescriptor({ id, version, ready: true, value });
      const measurement = measured.get(measurementKey);
      if (measurement) {
        measured.set(measurementKey, { ...measurement, sourceVersion: value });
      }
    });
    return () => {
      current = false;
    };
  }, [enabled, sourceVersion, id, version, measurementKey]);
  const [display, setDisplay] = useState<{
    id: number;
    url: string;
    failed: boolean;
  }>(() => {
    const prior = measured.get(measurementKey);
    const url =
      prior && enabled
        ? toGalleryThumbnailUrl(
            id,
            chooseGalleryThumbnailEdge(prior.width, prior.height, prior.dpr),
            version,
            sourceVersion ?? prior.sourceVersion
          )
        : "";
    return { id, url: isImageReady(url) ? url : "", failed: false };
  });
  const handleRef = useRef<ReturnType<typeof scheduleImage> | null>(null);
  const displayedUrl = useRef("");
  const priorityRef = useRef<ImagePriority>(0);
  priorityRef.current = visible ? 0 : (Math.max(1, priority) as ImagePriority);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!(element && enabled)) {
      return;
    }
    const update = () => {
      const bounds = element.getBoundingClientRect();
      const viewport = element
        .closest("[data-masonry-scroll]")
        ?.getBoundingClientRect();
      setVisible(
        bounds.bottom > (viewport?.top ?? 0) &&
          bounds.top < (viewport?.bottom ?? innerHeight) &&
          bounds.right > (viewport?.left ?? 0) &&
          bounds.left < (viewport?.right ?? innerWidth)
      );
      const next = {
        width: bounds.width || width,
        height: bounds.height || height,
        dpr: window.devicePixelRatio || 1,
        sourceVersion:
          sourceVersion ?? measured.get(measurementKey)?.sourceVersion,
      };
      const nextMeasurementKey = `${id}:${version}:${next.dpr}`;
      measured.delete(nextMeasurementKey);
      while (measured.size >= 4096) {
        measured.delete(measured.keys().next().value as string);
      }
      measured.set(nextMeasurementKey, next);
      setGeometry((current) =>
        current.width === next.width &&
        current.height === next.height &&
        current.dpr === next.dpr
          ? current
          : next
      );
    };
    const observer = new ResizeObserver(update);
    observer.observe(element);
    const intersection = new IntersectionObserver(
      ([entry]) => setVisible(entry.isIntersecting),
      { root: element.closest("[data-masonry-scroll]") }
    );
    intersection.observe(element);
    let media = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    const dpi = () => {
      update();
      media.removeEventListener("change", dpi);
      media = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      media.addEventListener("change", dpi);
    };
    media.addEventListener("change", dpi);
    update();
    return () => {
      observer.disconnect();
      intersection.disconnect();
      media.removeEventListener("change", dpi);
    };
  }, [enabled, width, height, version, measurementKey, sourceVersion, id]);
  const edge = chooseGalleryThumbnailEdge(
    geometry.width,
    geometry.height,
    geometry.dpr
  );
  const url =
    enabled &&
    geometry.width > 0 &&
    (sourceVersion ||
      (descriptor.id === id &&
        descriptor.version === version &&
        descriptor.ready))
      ? toGalleryThumbnailUrl(
          id,
          edge,
          version,
          sourceVersion ?? descriptor.value
        )
      : "";
  useEffect(() => {
    if (!url) {
      return;
    }
    let current = true;
    const handle = scheduleImage(url, {
      priority: priorityRef.current,
      consumer: `card:${id}`,
      generation: generation ?? version,
      holdUntilDisplayed: true,
    });
    handleRef.current = handle;
    handle.promise.then((result) => {
      if (!current || result === "cancelled") {
        return;
      }
      if (displayedUrl.current === url) {
        handle.release();
      }
      setDisplay((previous) => {
        if (result === "loaded") {
          return { id, url, failed: false };
        }
        return previous.id === id && previous.url
          ? previous
          : { id, url: "", failed: true };
      });
    });
    return () => {
      current = false;
      handle.release();
      handleRef.current = null;
    };
  }, [url, id, version, generation]);
  useEffect(() => {
    handleRef.current?.promote(
      visible ? 0 : (Math.max(1, priority) as ImagePriority)
    );
  }, [priority, visible]);
  const onDisplayed = useCallback(
    (displayed: string) => {
      displayedUrl.current = displayed;
      if (displayed === url) {
        handleRef.current?.release();
      }
    },
    [url]
  );
  return {
    ref,
    url: display.id === id ? display.url : "",
    failed: display.id === id && display.failed,
    onDisplayed,
  };
}
