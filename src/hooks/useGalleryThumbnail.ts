import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  chooseGalleryThumbnailEdge,
  GALLERY_CONFIG,
  type GalleryThumbnailEdge,
} from "@/utils/gallery-config";
import {
  getGalleryDpr,
  observeGalleryImage,
  subscribeGalleryDpr,
} from "@/utils/gallery-image-observer";
import { recordGalleryPerf } from "@/utils/gallery-perf";
import { requestThumbnailVersion } from "@/utils/gallery-thumbnail-descriptors";
import {
  getDecodedImageEdge,
  type ImagePriority,
  isImageReady,
  scheduleImage,
} from "@/utils/image-scheduler";
import { toGalleryThumbnailUrl } from "@/utils/local-media-url";

const measured = new Map<
  string,
  {
    width: number;
    height: number;
    dpr: number;
    sourceVersion?: string;
    sourceKey?: string;
    sourceRevision?: number;
    url?: string;
    edge?: GalleryThumbnailEdge;
  }
>();

interface ThumbnailDisplay {
  edge: GalleryThumbnailEdge;
  failed: boolean;
  key: string;
  sourceVersion?: string;
  url: string;
}
interface DescriptorScope {
  key: string;
  path: string;
  revision: number;
}
function nextDescriptorScope(
  current: DescriptorScope,
  key: string,
  path: string,
  prior?: { sourceKey?: string; sourceRevision?: number }
): DescriptorScope {
  const scope =
    current.key === key
      ? current
      : {
          key,
          path: prior?.sourceKey ?? "",
          revision: prior?.sourceRevision ?? 0,
        };
  if (!path || scope.path === path) {
    return scope;
  }
  // Hydrating a lightweight record's initially absent path is not a rename.
  return {
    key,
    path,
    revision: scope.revision + Number(Boolean(scope.path)),
  };
}
function requestUrl(
  enabled: boolean,
  width: number,
  ready: boolean,
  display: ThumbnailDisplay,
  key: string,
  identity: string | undefined,
  edge: GalleryThumbnailEdge,
  id: number,
  version: string,
  selectAvailable: boolean,
  repair: boolean
): string {
  if (!enabled || width <= 0 || !ready) {
    return "";
  }
  if (
    !repair &&
    display.key === key &&
    display.sourceVersion === identity &&
    display.url &&
    display.edge >= edge
  ) {
    return display.url;
  }
  return toGalleryThumbnailUrl(
    id,
    edge,
    version,
    identity,
    selectAvailable,
    repair
  );
}

function canStartImage(
  sourceVersion: string | undefined,
  priority: ImagePriority,
  descriptor: { key: string; ready: boolean },
  key: string
): boolean {
  return Boolean(
    sourceVersion ||
      priority === 0 ||
      (descriptor.key === key && descriptor.ready)
  );
}

function getSourceRequestState<T extends { sourceRevision?: number }>(
  version: string,
  revision: number,
  measurement: T | undefined
) {
  return {
    imageVersion: revision ? `${version}:source-${revision}` : version,
    prior: measurement?.sourceRevision === revision ? measurement : undefined,
  };
}

/** Keep the decoded resource while resizing, cancelling, or preparing an upgrade. */
export function useGalleryThumbnail({
  id,
  version,
  sourceVersion,
  sourceKey = "",
  sourceAspect,
  width,
  height,
  layoutWidth,
  layoutHeight,
  visible: suppliedVisible,
  enabled,
  requestImage = true,
  priority = 0,
  generation,
  idle = true,
}: {
  id: number;
  version: string;
  sourceVersion?: string;
  sourceKey?: string;
  sourceAspect?: number;
  width: number;
  height: number;
  layoutWidth?: number;
  layoutHeight?: number;
  visible?: boolean;
  enabled: boolean;
  requestImage?: boolean;
  priority?: ImagePriority;
  generation?: string;
  idle?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const subscribeDpr = useCallback(
    (listener: () => void) =>
      enabled ? subscribeGalleryDpr(listener) : () => undefined,
    [enabled]
  );
  const dpr = useSyncExternalStore(subscribeDpr, getGalleryDpr);
  // Rich records can hydrate their path after the lightweight ID already
  // started loading. That is not a new image generation.
  const scopeKey = `${generation ?? ""}:${id}:${version}`;
  const measurementKey = `${scopeKey}:${dpr}`;
  const previousMeasurement = measured.get(measurementKey);
  const descriptorScope = useRef<DescriptorScope>({
    key: "",
    path: "",
    revision: 0,
  });
  descriptorScope.current = nextDescriptorScope(
    descriptorScope.current,
    scopeKey,
    sourceKey,
    previousMeasurement
  );
  const { path: scopePath, revision: sourceRevision } = descriptorScope.current;
  const key = `${scopeKey}:${sourceRevision}`;
  const descriptorGeneration = key;
  const { imageVersion, prior } = getSourceRequestState(
    version,
    sourceRevision,
    previousMeasurement
  );
  const [geometry, setGeometry] = useState(() => ({
    width: prior?.width ?? 0,
    height: prior?.height ?? 0,
    key: "",
  }));
  const [visible, setVisible] = useState(priority === 0);
  const hasLayout = Boolean(layoutWidth && layoutHeight);
  const actualWidth = hasLayout ? (layoutWidth ?? 0) : geometry.width;
  const actualHeight = hasLayout ? (layoutHeight ?? 0) : geometry.height;
  const edge = chooseGalleryThumbnailEdge(
    actualWidth,
    actualHeight,
    dpr,
    sourceAspect
  );
  const cachedUrl = prior?.url ?? "";
  const [descriptor, setDescriptor] = useState<{
    key: string;
    ready: boolean;
    value?: string;
  }>(() => ({
    key,
    ready: Boolean(
      sourceVersion || (prior?.sourceVersion && isImageReady(cachedUrl))
    ),
    value: sourceVersion ?? prior?.sourceVersion,
  }));
  const [display, setDisplay] = useState<ThumbnailDisplay>(() => ({
    key,
    url: enabled && isImageReady(cachedUrl) ? cachedUrl : "",
    edge: prior?.edge ?? edge,
    sourceVersion: prior?.sourceVersion ?? sourceVersion,
    failed: false,
  }));
  const [failedHint, setFailedHint] = useState<{
    key: string;
    identity?: string;
    edge?: GalleryThumbnailEdge;
  }>();
  const handleRef = useRef<ReturnType<typeof scheduleImage> | null>(null);
  const descriptorRef = useRef<ReturnType<
    typeof requestThumbnailVersion
  > | null>(null);
  const resolvedDescriptor = useRef<
    | {
        key: string;
        value?: string;
      }
    | undefined
  >(undefined);
  const displayedUrl = useRef("");
  const decodedAt = useRef<{ url: string; at: number } | null>(null);
  const priorityRef = useRef<ImagePriority>(0);
  const loadPriority =
    (suppliedVisible ?? visible) ? 0 : (Math.max(1, priority) as ImagePriority);
  priorityRef.current = loadPriority;
  const canRequest = enabled && requestImage;

  useLayoutEffect(() => {
    const element = ref.current;
    if (
      !(element && canRequest) ||
      (hasLayout && suppliedVisible !== undefined)
    ) {
      return;
    }
    return observeGalleryImage(
      element,
      hasLayout
        ? undefined
        : (w, h) => {
            const next = { width: w || width, height: h || height, key };
            setGeometry((current) =>
              current.width === next.width &&
              current.height === next.height &&
              current.key === key
                ? current
                : next
            );
          },
      suppliedVisible === undefined ? setVisible : undefined
    );
  }, [canRequest, hasLayout, suppliedVisible, width, height, key]);

  useEffect(() => {
    if (!canRequest || sourceVersion || loadPriority === 0) {
      return;
    }
    const resolved = resolvedDescriptor.current;
    if (resolved?.key === descriptorGeneration) {
      return;
    }
    let current = true;
    const handle = requestThumbnailVersion(id, {
      consumer: `card:${id}`,
      priority: priorityRef.current,
      generation: descriptorGeneration,
    });
    descriptorRef.current = handle;
    handle.resource.then((resource) => {
      if (current) {
        resolvedDescriptor.current = {
          key: descriptorGeneration,
          value: resource?.thumbnailVersion,
        };
        setDescriptor({
          key,
          ready: true,
          value: resource?.thumbnailVersion,
        });
      }
    });
    return () => {
      current = false;
      handle.release();
      descriptorRef.current = null;
    };
  }, [canRequest, sourceVersion, id, key, descriptorGeneration, loadPriority]);

  const identity =
    sourceVersion ??
    (descriptor.key === key && descriptor.ready ? descriptor.value : undefined);
  const ready = canStartImage(sourceVersion, loadPriority, descriptor, key);
  const repair =
    failedHint?.key === key &&
    failedHint.identity === sourceVersion &&
    failedHint.edge === edge;
  const selectAvailable = !(sourceVersion || repair);
  const url = requestUrl(
    canRequest,
    actualWidth,
    ready && (hasLayout || geometry.key === key),
    display,
    key,
    sourceVersion,
    edge,
    id,
    imageVersion,
    selectAvailable,
    repair
  );
  const targetRef = useRef({
    edge,
    requestedEdge: edge,
    identity: sourceVersion,
    repair,
  });
  targetRef.current = {
    edge: url === display.url ? display.edge : edge,
    requestedEdge: edge,
    identity: sourceVersion,
    repair,
  };
  useLayoutEffect(() => {
    if (!(actualWidth && actualHeight)) {
      return;
    }
    measured.delete(measurementKey);
    while (measured.size >= 4096) {
      measured.delete(measured.keys().next().value as string);
    }
    const decoded = display.key === key && display.url ? display : undefined;
    measured.set(measurementKey, {
      width: actualWidth,
      height: actualHeight,
      dpr,
      sourceVersion: decoded ? decoded.sourceVersion : identity,
      sourceKey: scopePath,
      sourceRevision,
      url: decoded?.url,
      edge: decoded?.edge,
    });
  }, [
    measurementKey,
    actualWidth,
    actualHeight,
    dpr,
    identity,
    display,
    key,
    scopePath,
    sourceRevision,
  ]);

  useEffect(() => {
    if (!url) {
      return;
    }
    let current = true;
    const target = targetRef.current;
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
      if (result === "failed" && !target.repair) {
        // Retry this resource once from the source. Metadata validation alone
        // cannot detect every damaged pixel payload, even at an exact tier.
        setFailedHint({
          key,
          identity: target.identity,
          edge: target.requestedEdge,
        });
        return;
      }
      if (result === "loaded") {
        decodedAt.current = { url, at: performance.now() };
      }
      if (displayedUrl.current === url) {
        handle.release();
        decodedAt.current = null;
      }
      setDisplay((previous) => {
        if (result === "loaded") {
          return {
            key,
            url,
            edge: Math.max(
              target.edge,
              chooseGalleryThumbnailEdge(getDecodedImageEdge(url) ?? 1, 1, 1)
            ) as GalleryThumbnailEdge,
            sourceVersion: target.identity,
            failed: false,
          };
        }
        if (previous.key === key && previous.url) {
          return previous;
        }
        return {
          key,
          url: "",
          edge: target.edge,
          sourceVersion: target.identity,
          failed: true,
        };
      });
    });
    return () => {
      current = false;
      handle.release();
      handleRef.current = null;
    };
  }, [url, id, key, generation, version]);
  useEffect(() => {
    handleRef.current?.promote(loadPriority);
    descriptorRef.current?.promote(loadPriority);
  }, [loadPriority]);
  useEffect(() => {
    if (
      !(canRequest && idle && (suppliedVisible ?? visible) && display.url) ||
      display.key !== key ||
      display.edge <= edge
    ) {
      return;
    }
    let handle: ReturnType<typeof scheduleImage> | undefined;
    const timer = setTimeout(() => {
      handle = scheduleImage(
        toGalleryThumbnailUrl(id, edge, imageVersion, identity),
        {
          priority: 2,
          consumer: `variant-warm:${id}`,
          generation: generation ?? version,
          retainDecoded: false,
          idleOnly: true,
        }
      );
    }, GALLERY_CONFIG.thumbnailVariantWarmIdleMs);
    return () => {
      clearTimeout(timer);
      handle?.release();
    };
  }, [
    canRequest,
    idle,
    suppliedVisible,
    visible,
    display,
    key,
    edge,
    id,
    version,
    imageVersion,
    identity,
    generation,
  ]);
  const onDisplayed = useCallback(
    (displayed: string) => {
      displayedUrl.current = displayed;
      if (decodedAt.current?.url === displayed) {
        recordGalleryPerf(
          "imageHandoffMs",
          performance.now() - decodedAt.current.at
        );
        decodedAt.current = null;
      }
      if (displayed === url) {
        handleRef.current?.release();
      }
    },
    [url]
  );
  return {
    ref,
    url: display.key === key ? display.url : "",
    failed: display.key === key && display.failed,
    onDisplayed,
  };
}
