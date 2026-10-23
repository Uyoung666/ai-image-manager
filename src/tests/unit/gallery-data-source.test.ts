import { describe, expect, it, vi } from "vitest";
import type { Photo } from "@/types/photo";
import {
  ensureGalleryPhotos,
  GalleryDataSource,
  getGalleryGeometryKey,
  readGalleryPhotoRecords,
} from "@/utils/gallery-data-source";
import {
  computeMasonryChunk,
  MasonryGeometryBlocks,
} from "@/utils/masonry-engine";

const entries = Array.from({ length: 2500 }, (_, index) => ({
  id: index + 1,
  width: 100,
  height: 150,
  fileDate: index,
}));
const record = (id: number): Photo => ({
  id,
  path: `C:/fixture/${id}.jpg`,
  filename: `${id}.jpg`,
  width: 100,
  height: 150,
  fileDate: id - 1,
  fileSize: 1000,
  thumbnailPath: `${id}.webp`,
  isIndexed: true,
});
describe("windowed gallery data", () => {
  it("bounds sparse pinned views without losing their resident records", async () => {
    const source = new GalleryDataSource("sparse", async (ids) =>
      ids.map(record)
    );
    const photos = source.append(
      Array.from({ length: 10_000 }, (_, index) => ({
        ...entries[0],
        id: index + 1,
      }))
    );
    const indices = Array.from({ length: 80 }, (_, index) => index * 100);
    await source.ensureIndices(indices, true);
    expect(source.getStats().pages).toBeLessThanOrEqual(20);
    for (const index of indices) {
      expect(photos[index].path).toBe(`C:/fixture/${index + 1}.jpg`);
    }
    source.updateFavorites([1], true);
    expect(photos[0].isFavorite).toBe(true);
    expect(photos[0].path).toBe("C:/fixture/1.jpg");
    source.clearRecords();
    expect(photos[0].path).toBe("");
    await source.ensureRange(0, 0, true);
    expect(photos[0].path).toBe("C:/fixture/1.jpg");
  });
  it("resolves a complete large operation in <=1000-ID batches without pinning selected records", async () => {
    const loader = vi.fn(async (ids: number[]) => ids.map(record));
    const source = new GalleryDataSource("operation", loader);
    const selected = source.append(entries);
    const resolved = await readGalleryPhotoRecords(selected);
    expect(resolved).toHaveLength(2500);
    expect(loader.mock.calls.map(([ids]) => ids.length)).toEqual([
      1000, 1000, 500,
    ]);
    expect(source.getStats().pages).toBe(0);
    expect(resolved[2499].path).toBe("C:/fixture/2500.jpg");
  });
  it("evicts full records while preserving IDs, geometry, range selection and reloading", async () => {
    const loader = vi.fn(async (ids: number[]) => ids.map(record));
    const source = new GalleryDataSource("test", loader);
    const photos = source.append(entries);
    expect(getGalleryGeometryKey(photos)).toBe("test:0");
    for (let page = 0; page < 25; page++) {
      await source.ensureRange(page * 100, page * 100 + 99, true);
    }
    expect(source.getStats().pages).toBeLessThanOrEqual(20);
    expect(photos[0].id).toBe(1);
    expect(photos[0].width).toBe(100);
    expect(photos[0].path).toBe("");
    expect(photos.slice(0, 2050).map((photo) => photo.id)).toHaveLength(2050);
    await ensureGalleryPhotos(photos.slice(0, 2), true);
    expect(photos[0].path).toBe("C:/fixture/1.jpg");
    expect({ ...photos[0] }).toMatchObject(record(1));
  });
  it("ignores an old load after disposing a context", async () => {
    let finish!: (photos: Photo[]) => void;
    const source = new GalleryDataSource(
      "old",
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    source.append(entries.slice(0, 1));
    const load = source.ensureRange(0, 0);
    source.clearRecords();
    finish([record(1)]);
    await load;
    expect(source.getStats().pages).toBe(0);
  });
  it("keeps append geometry identical to a full layout without copying old blocks", () => {
    const input = {
      items: entries.slice(0, 1000),
      colWidth: 200,
      columns: 5,
      gap: 8,
      start: 0,
      headers: [{ beforeIndex: 1000, label: "next" }],
      showHeaders: true,
    };
    const initial = computeMasonryChunk(input);
    const store = new MasonryGeometryBlocks();
    store.append(initial.data);
    const old = store.views();
    const next = store.fork();
    next.append(
      computeMasonryChunk({
        ...input,
        items: entries.slice(1000),
        start: 1000,
        heights: initial.heights,
        maxBottom: initial.maxBottom,
      }).data
    );
    const full = computeMasonryChunk({ ...input, items: entries });
    for (const index of [0, 999, 1000, 2499]) {
      expect(next.value(index, 0)).toBe(full.data[index * 5]);
      expect(next.value(index, 4)).toBe(full.data[index * 5 + 4]);
    }
    expect(old.positions).toHaveLength(1000);
    expect(next.views().positions).toHaveLength(2500);
  });
});
