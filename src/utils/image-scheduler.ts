import { GALLERY_CONFIG } from "./gallery-config";
import { recordGalleryPerf } from "./gallery-perf";

export type ImageLoadResult = "loaded" | "failed" | "cancelled";
export type ImagePriority = 0 | 1 | 2;
interface Consumer {
  generation?: string | number;
  holdUntilDisplayed: boolean;
  priority: ImagePriority;
  release?: () => void;
  resolve: (result: ImageLoadResult) => void;
}
interface Task {
  activePriority: ImagePriority;
  cancel?: () => void;
  consumers: Set<Consumer>;
  element?: HTMLImageElement;
  idleOnly: boolean;
  priority: ImagePriority;
  queuedAt: number;
  result?: ImageLoadResult;
  retainDecoded: boolean;
  started: boolean;
  url: string;
}
const tasks = new Map<string, Task>();
let running = 0;
let prefetch = 0;
let releasingGeneration = false;
let pumpScheduled = false;
function queuePump(): void {
  if (pumpScheduled) {
    return;
  }
  pumpScheduled = true;
  queueMicrotask(() => {
    pumpScheduled = false;
    pump();
  });
}
// Short transfer window for a freshly decoded native image across mode remounts.
// Every reuse checks the actual element; this is not a remembered-success URL set.
const decoded = new Map<string, { image: HTMLImageElement; at: number }>();
export function isImageReady(url: string): boolean {
  const entry = decoded.get(url);
  if (!entry) {
    return false;
  }
  if (
    performance.now() - entry.at > 2000 ||
    !entry.image.complete ||
    entry.image.naturalWidth <= 0
  ) {
    decoded.delete(url);
    return false;
  }
  return true;
}

export function getDecodedImageEdge(url: string): number | undefined {
  if (!isImageReady(url)) {
    return undefined;
  }
  const image = decoded.get(url)?.image;
  return image ? Math.max(image.naturalWidth, image.naturalHeight) : undefined;
}

function start(task: Task): void {
  task.started = true;
  task.activePriority = task.priority;
  running++;
  if (task.activePriority > 0) {
    prefetch++;
  }
  recordGalleryPerf("imageQueueMs", performance.now() - task.queuedAt);
  recordGalleryPerf("imageActive", running);
  recordGalleryPerf("imagePrefetchActive", prefetch);
  let image: HTMLImageElement;
  let timer: ReturnType<typeof setTimeout>;
  let done = false;
  let attempt = 0;
  let serial = 0;
  let disposed = false;
  const dispose = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    clearTimeout(timer);
    tasks.delete(task.url);
    running--;
    if (task.activePriority > 0) {
      prefetch--;
    }
    if (task.result === "cancelled") {
      queuePump();
    } else {
      pump();
    }
  };
  const finish = (result: ImageLoadResult) => {
    if (done) {
      return;
    }
    done = true;
    task.result = result;
    if (result === "loaded" && task.retainDecoded) {
      decoded.delete(task.url);
      while (decoded.size >= 64) {
        decoded.delete(decoded.keys().next().value as string);
      }
      const ready = { image, at: performance.now() };
      decoded.set(task.url, ready);
      setTimeout(() => {
        if (decoded.get(task.url) === ready) {
          decoded.delete(task.url);
        }
      }, 2000);
    }
    clearTimeout(timer);
    image.onload = null;
    image.onerror = null;
    if (result !== "loaded") {
      image.src = "";
    }
    for (const consumer of task.consumers) {
      consumer.resolve(result);
      if (!consumer.holdUntilDisplayed || result !== "loaded") {
        task.consumers.delete(consumer);
      }
    }
    recordGalleryPerf(`image${result}`, 1);
    if (result === "loaded" && task.consumers.size > 0) {
      // Keep the slot through the DOM image's cache validation and reveal.
      task.cancel = dispose;
      timer = setTimeout(dispose, GALLERY_CONFIG.imageTimeoutMs);
    } else {
      task.consumers.clear();
      dispose();
    }
  };
  const load = () => {
    const current = ++serial;
    const started = performance.now();
    let loadedAt = started;
    image = task.element ?? new Image();
    image.decoding = "async";
    image.fetchPriority = task.priority === 0 ? "high" : "low";
    const failed = (transient = false) => {
      if (done || serial !== current) {
        return;
      }
      clearTimeout(timer);
      image.onload = null;
      image.onerror = null;
      image.src = "";
      if (
        transient &&
        task.priority === 0 &&
        attempt++ === 0 &&
        task.consumers.size > 0
      ) {
        load();
      } else {
        finish("failed");
      }
    };
    image.onerror = () => failed();
    const loaded = () => {
      if (done || serial !== current) {
        return;
      }
      recordGalleryPerf("imageDecodeMs", performance.now() - loadedAt);
      recordGalleryPerf("imageLoadMs", performance.now() - started);
      finish("loaded");
    };
    image.onload = () => {
      loadedAt = performance.now();
      recordGalleryPerf("imageReadMs", loadedAt - started);
      if (typeof image.decode !== "function") {
        loaded();
      }
    };
    timer = setTimeout(() => failed(true), GALLERY_CONFIG.imageTimeoutMs);
    image.src = task.url;
    if (typeof image.decode === "function") {
      image.decode().then(loaded, () => failed());
    }
  };
  task.cancel = () => finish("cancelled");
  load();
}

function pump(): void {
  if (releasingGeneration) {
    return;
  }
  while (running < GALLERY_CONFIG.imageConcurrency) {
    const foreground = [...tasks.values()].some((task) => task.priority === 0);
    const next = [...tasks.values()]
      .filter(
        (task) =>
          !task.started &&
          (!task.idleOnly || task.priority === 0 || !foreground) &&
          (task.priority === 0 || prefetch < GALLERY_CONFIG.prefetchConcurrency)
      )
      .sort((a, b) => a.priority - b.priority || a.queuedAt - b.queuedAt)[0];
    if (!next) {
      break;
    }
    start(next);
  }
}

/** A handle is one consumer, not ownership of the shared resource. */
export function scheduleImage(
  url: string,
  options: {
    signal?: AbortSignal;
    priority?: ImagePriority;
    consumer?: string;
    generation?: string | number;
    holdUntilDisplayed?: boolean;
    element?: HTMLImageElement;
    retainDecoded?: boolean;
    idleOnly?: boolean;
  } = {}
): {
  promise: Promise<ImageLoadResult>;
  promote: (priority: ImagePriority) => void;
  release: () => void;
} {
  const priority = options.priority ?? 2;
  let resolve!: (result: ImageLoadResult) => void;
  const promise = new Promise<ImageLoadResult>((done) => {
    resolve = done;
  });
  const consumer: Consumer = {
    generation: options.generation,
    resolve,
    priority,
    holdUntilDisplayed: options.holdUntilDisplayed ?? false,
  };
  let task = tasks.get(url);
  if (!task) {
    task = {
      url,
      consumers: new Set(),
      priority,
      activePriority: priority,
      started: false,
      queuedAt: performance.now(),
      element: options.element,
      retainDecoded: options.retainDecoded ?? true,
      idleOnly: options.idleOnly ?? false,
    };
    tasks.set(url, task);
  }
  const active = task;
  active.retainDecoded ||= options.retainDecoded ?? true;
  active.idleOnly &&= options.idleOnly ?? false;
  active.consumers.add(consumer);
  if (active.result) {
    resolve(active.result);
  }
  active.priority = Math.min(active.priority, priority) as ImagePriority;
  const release = () => {
    options.signal?.removeEventListener("abort", release);
    if (!active.consumers.delete(consumer)) {
      return;
    }
    resolve("cancelled");
    if (active.consumers.size === 0) {
      if (active.started) {
        active.cancel?.();
      } else {
        tasks.delete(url);
      }
    } else {
      active.priority = Math.min(
        ...[...active.consumers].map((entry) => entry.priority)
      ) as ImagePriority;
    }
    queuePump();
  };
  consumer.release = release;
  options.signal?.addEventListener("abort", release, { once: true });
  promise.then(() => options.signal?.removeEventListener("abort", release));
  if (options.signal?.aborted) {
    release();
  } else {
    pump();
  }
  return {
    promise,
    release,
    promote: (next) => {
      consumer.priority = next;
      active.priority = Math.min(
        ...[...active.consumers].map((entry) => entry.priority)
      ) as ImagePriority;
      pump();
    },
  };
}

export function releaseImageGeneration(generation: string | number): void {
  releasingGeneration = true;
  try {
    for (const task of [...tasks.values()]) {
      for (const consumer of [...task.consumers]) {
        if (consumer.generation === generation) {
          consumer.release?.();
        }
      }
    }
  } finally {
    releasingGeneration = false;
    pump();
  }
}
