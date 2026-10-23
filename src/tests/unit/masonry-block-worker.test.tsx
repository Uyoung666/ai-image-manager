import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useBlockedMasonryLayout } from "@/hooks/useBlockedMasonryLayout";
import { GalleryDataSource } from "@/utils/gallery-data-source";
import {
  computeMasonryChunk,
  type MasonryEngineInput,
} from "@/utils/masonry-engine";

const jobs = vi.hoisted(
  () =>
    [] as Array<{
      input: MasonryEngineInput;
      finish: (value: ReturnType<typeof computeMasonryChunk>) => void;
    }>
);
vi.mock("@/utils/masonry-worker-client", () => ({
  computeMasonryInWorker: (input: MasonryEngineInput) =>
    new Promise((finish) => jobs.push({ input, finish })),
}));
const create = (key: string, count: number) => {
  const source = new GalleryDataSource(key, async () => []);
  return source.append(
    Array.from({ length: count }, (_, index) => ({
      id: index + 1,
      width: 100,
      height: [80, 120, 200][index % 3],
      fileDate: index,
    }))
  );
};
describe("atomic blocked masonry", () => {
  it("commits the item order together with geometry after a data generation changes", async () => {
    jobs.length = 0;
    const original = create("first-generation", 3000);
    const next = new GalleryDataSource(
      "second-generation",
      async () => []
    ).append(
      Array.from({ length: 6000 }, (_, index) => ({
        id: index + 10_000,
        width: 200,
        height: 100,
      }))
    );
    const { result, rerender } = renderHook(
      ({ items }) =>
        useBlockedMasonryLayout(items, 1000, 5, 8, [], "same-route", false),
      { initialProps: { items: original } }
    );
    const previous = result.current;
    rerender({ items: next });
    expect(result.current?.positions).toBe(previous?.positions);
    expect(result.current?.renderItems).toBe(original);
    const job = jobs.at(-1);
    if (!job) {
      throw new Error("Expected worker geometry for the new generation");
    }
    await act(async () => job.finish(computeMasonryChunk(job.input)));
    await waitFor(() => expect(result.current?.renderItems).toBe(next));
    expect(result.current?.positions).toHaveLength(6000);
    expect(result.current?.renderItems?.[0].id).toBe(10_000);
  });
  it("rebuilds a changed tail from a block checkpoint with unchanged geometry", () => {
    const original = create("before", 3000);
    const { result, rerender } = renderHook(
      ({ items }) =>
        useBlockedMasonryLayout(items, 1000, 5, 8, [], "scope", false),
      { initialProps: { items: original } }
    );
    const first = result.current?.positions[500];
    const next = create("after", 3000).filter((photo) => photo.id !== 1501);
    // A derived gallery view keeps a stable geometry protocol across filtering.
    const source = new GalleryDataSource("changed", async () => []);
    const changed = source.append(next);
    rerender({ items: changed });
    const full = computeMasonryChunk({
      items: changed,
      colWidth: (1000 - 32) / 5,
      columns: 5,
      gap: 8,
      start: 0,
      headers: [],
      showHeaders: false,
    });
    expect(result.current?.positions[500]).toEqual(first);
    expect(result.current?.positions[2400].top).toBe(full.data[2400 * 5]);
  });
  it("drops late worker results and preserves the last committed layout during resize", async () => {
    jobs.length = 0;
    const items = create("large", 6000);
    const { result, rerender } = renderHook(
      ({ width }) =>
        useBlockedMasonryLayout(items, width, 5, 8, [], "large", false),
      { initialProps: { width: 1000 } }
    );
    const old = jobs[0];
    rerender({ width: 800 });
    const latest = jobs.at(-1);
    if (!latest) {
      throw new Error("Expected a worker request");
    }
    await act(async () => old.finish(computeMasonryChunk(old.input)));
    expect(result.current?.positions).toHaveLength(0);
    await act(async () => latest.finish(computeMasonryChunk(latest.input)));
    await waitFor(() => expect(result.current?.positions).toHaveLength(6000));
    const committed = result.current?.positions;
    rerender({ width: 900 });
    expect(result.current?.positions).toBe(committed);
  });
});
