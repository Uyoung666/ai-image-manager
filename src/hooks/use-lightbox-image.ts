import { useEffect, useMemo, useRef, useState } from "react";
import { scheduleImage } from "@/utils/image-scheduler";

/** Tracks one mounted image request, including cached loads and async decoding. */
export function useLightboxImage({
  enabled,
  photoId,
  src,
  retry,
}: {
  enabled: boolean;
  photoId: number | undefined;
  src: string | null;
  retry: number;
}) {
  const ref = useRef<HTMLImageElement>(null);
  const request = useMemo(
    () => ({ enabled, photoId, retry, src }),
    [enabled, photoId, retry, src]
  );
  const [result, setResult] = useState<{
    request: typeof request;
    status: "loaded" | "error";
  } | null>(null);

  useEffect(() => {
    const image = ref.current;
    if (!(enabled && src && image)) {
      return;
    }
    let active = true;
    let decoding = false;
    const fail = () => {
      if (active) {
        setResult({ request, status: "error" });
      }
    };
    const load = async () => {
      if (decoding) {
        return;
      }
      decoding = true;
      try {
        await image.decode?.();
        if (active) {
          setResult({ request, status: "loaded" });
        }
      } catch {
        fail();
      }
    };
    image.addEventListener("load", load);
    image.addEventListener("error", fail);
    const handle = scheduleImage(src, {
      priority: 0,
      consumer: "lightbox",
      element: image,
    });
    handle.promise.then((status) => {
      if (!active || status === "cancelled") {
        return;
      }
      if (status === "failed") {
        fail();
        return;
      }
      if (image.src !== src) {
        image.src = src;
      }
      load();
    });
    // A queued element has no src yet. Only inspect a cache result once the
    // scheduler has assigned this request's source to the real DOM image.
    if (image.getAttribute("src") === src && image.complete) {
      if (image.naturalWidth > 0) {
        load();
      } else {
        fail();
      }
    }
    return () => {
      active = false;
      handle.release();
      image.removeEventListener("load", load);
      image.removeEventListener("error", fail);
    };
  }, [enabled, request, src]);

  return {
    error: enabled && result?.request === request && result.status === "error",
    loaded:
      enabled && result?.request === request && result.status === "loaded",
    ref,
    request,
  };
}
