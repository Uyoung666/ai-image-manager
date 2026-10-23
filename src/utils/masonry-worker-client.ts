import type { computeMasonryChunk, MasonryEngineInput } from "./masonry-engine";

let worker: Worker | null = null;
let next = 0;
const pending = new Map<
  number,
  {
    resolve: (value: ReturnType<typeof computeMasonryChunk>) => void;
    reject: (reason: Error) => void;
  }
>();
export function computeMasonryInWorker(
  input: MasonryEngineInput
): Promise<ReturnType<typeof computeMasonryChunk>> {
  if (!worker) {
    worker = new Worker(
      new URL("../workers/masonry.worker.ts", import.meta.url),
      { type: "module" }
    );
    worker.onmessage = (
      event: MessageEvent<{
        id: number;
        result: ReturnType<typeof computeMasonryChunk>;
      }>
    ) => {
      const task = pending.get(event.data.id);
      pending.delete(event.data.id);
      task?.resolve(event.data.result);
    };
    worker.onerror = () => {
      for (const task of pending.values()) {
        task.reject(new Error("Masonry worker failed"));
      }
      pending.clear();
      worker?.terminate();
      worker = null;
    };
  }
  const id = ++next;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker?.postMessage({ id, input });
  });
}

export function shutdownMasonryWorker(): void {
  worker?.terminate();
  worker = null;
  for (const task of pending.values()) {
    task.reject(new Error("Masonry worker closed"));
  }
  pending.clear();
}
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", shutdownMasonryWorker);
}
