import { photoListingActions } from "@/actions/photo-listing";
import { GALLERY_CONFIG, type GalleryThumbnailEdge } from "./gallery-config";
import { recordGalleryPerf } from "./gallery-perf";
import type { ImagePriority } from "./image-scheduler";

export interface ThumbnailDescriptorResource {
  availableEdge?: GalleryThumbnailEdge;
  thumbnailVersion?: string;
}
interface Consumer {
  priority: ImagePriority;
  resolve: (resource: ThumbnailDescriptorResource | undefined) => void;
}
interface Task {
  consumers: Set<Consumer>;
  edge?: GalleryThumbnailEdge;
  id: number;
  key: string;
  settled?: boolean;
  started: boolean;
  value?: ThumbnailDescriptorResource;
}
const tasks = new Map<string, Task>();
let scheduled = false;
let running = 0;
let prefetch = 0;
const priorityOf = (task: Task): ImagePriority =>
  Math.min(...[...task.consumers].map((c) => c.priority)) as ImagePriority;

function pump(): void {
  scheduled = false;
  while (running < GALLERY_CONFIG.thumbnailDescriptorRequests) {
    const queued = [...tasks.values()]
      .filter(
        (task) =>
          !task.started &&
          task.consumers.size > 0 &&
          (priorityOf(task) === 0 ||
            prefetch < GALLERY_CONFIG.thumbnailDescriptorPrefetchRequests)
      )
      .sort((a, b) => priorityOf(a) - priorityOf(b));
    const first = queued[0];
    if (!first) {
      return;
    }
    const priority = priorityOf(first);
    const batch = queued
      .filter((task) => priorityOf(task) === priority)
      .slice(0, GALLERY_CONFIG.thumbnailDescriptorBatchSize);
    for (const task of batch) {
      task.started = true;
    }
    running++;
    if (priority > 0) {
      prefetch++;
    }
    recordGalleryPerf("descriptorActive", running);
    recordGalleryPerf("descriptorPrefetchActive", prefetch);
    const started = performance.now();
    // Cancellation never frees this real IPC slot before the request settles.
    const edges = new Map<number, GalleryThumbnailEdge>();
    for (const task of batch) {
      if (task.edge) {
        edges.set(
          task.id,
          Math.min(
            edges.get(task.id) ?? task.edge,
            task.edge
          ) as GalleryThumbnailEdge
        );
      }
    }
    photoListingActions
      .thumbnailVersions(
        [...new Set(batch.map((task) => task.id))],
        priority,
        edges.size ? edges : undefined
      )
      .then((records) => {
        const versions = new Map(records.map((item) => [item.id, item]));
        for (const task of batch) {
          task.settled = true;
          task.value = versions.get(task.id);
          for (const consumer of task.consumers) {
            consumer.resolve(task.value);
          }
        }
      })
      .catch(() => {
        // The HTTP request supplies the normal missing/error UI.
        for (const task of batch) {
          task.settled = true;
          for (const consumer of task.consumers) {
            consumer.resolve(undefined);
          }
        }
      })
      .finally(() => {
        recordGalleryPerf("descriptorBatchMs", performance.now() - started);
        for (const task of batch) {
          task.consumers.clear();
          if (tasks.get(task.key) === task) {
            tasks.delete(task.key);
          }
        }
        running--;
        if (priority > 0) {
          prefetch--;
        }
        schedule();
      });
  }
}
function schedule(): void {
  if (scheduled) {
    return;
  }
  scheduled = true;
  queueMicrotask(pump);
}

/** One short-lived consumer; no remembered-success cache or arbitrary paths. */
export function requestThumbnailVersion(
  id: number,
  options: {
    consumer?: string;
    generation?: string;
    priority?: ImagePriority;
    edge?: GalleryThumbnailEdge;
  } = {}
) {
  const key = `${options.generation ?? ""}:${id}:${options.edge ?? ""}`;
  let resolve!: Consumer["resolve"];
  const resource = new Promise<ThumbnailDescriptorResource | undefined>(
    (done) => {
      resolve = done;
    }
  );
  const consumer: Consumer = { resolve, priority: options.priority ?? 0 };
  let task = tasks.get(key);
  if (!task) {
    task = {
      key,
      id,
      edge: options.edge,
      started: false,
      consumers: new Set(),
    };
    tasks.set(key, task);
  }
  const active = task;
  active.consumers.add(consumer);
  if (active.settled) {
    resolve(active.value);
  }
  schedule();
  return {
    resource,
    promise: resource.then((value) => value?.thumbnailVersion),
    promote(priority: ImagePriority) {
      consumer.priority = priority;
      schedule();
    },
    release() {
      if (!active.consumers.delete(consumer)) {
        return;
      }
      resolve(undefined);
      if (active.consumers.size === 0 && tasks.get(key) === active) {
        tasks.delete(key);
      }
      schedule();
    },
  };
}
