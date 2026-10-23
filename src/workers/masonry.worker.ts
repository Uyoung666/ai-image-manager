import {
  computeMasonryChunk,
  type MasonryEngineInput,
} from "@/utils/masonry-engine";

self.onmessage = (
  event: MessageEvent<{ id: number; input: MasonryEngineInput }>
) => {
  const result = computeMasonryChunk(event.data.input);
  self.postMessage(
    { id: event.data.id, result },
    { transfer: [result.data.buffer] }
  );
};
