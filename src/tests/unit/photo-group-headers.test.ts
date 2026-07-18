import { describe, expect, it } from "vitest";
import {
  buildPhotoGroupHeaders,
  hasMatchingPhotoGroupPrefix,
  snapshotPhotoGroupInputs,
} from "@/utils/photo-group-headers";

describe("photo group header cache inputs", () => {
  const original = [
    { fileDate: 100, id: 1 },
    { fileDate: 200, id: 2 },
    { fileDate: 300, id: 3 },
  ];

  it("rejects an equal-length list whose interior item changed", () => {
    const snapshot = snapshotPhotoGroupInputs(original);
    expect(
      hasMatchingPhotoGroupPrefix(snapshot, [
        original[0],
        { fileDate: 200, id: 9 },
        original[2],
      ])
    ).toBe(false);
  });

  it("rejects a list whose cached item date changed", () => {
    const snapshot = snapshotPhotoGroupInputs(original);
    expect(
      hasMatchingPhotoGroupPrefix(snapshot, [
        original[0],
        { fileDate: 999, id: 2 },
        original[2],
      ])
    ).toBe(false);
  });

  it("accepts a genuine tail append", () => {
    const snapshot = snapshotPhotoGroupInputs(original);
    expect(
      hasMatchingPhotoGroupPrefix(snapshot, [
        ...original,
        { fileDate: 400, id: 4 },
      ])
    ).toBe(true);
  });

  it("appends a new month header at the global photo index", () => {
    const january = new Date(2026, 0, 10).getTime();
    const february = new Date(2026, 1, 10).getTime();
    const photos = [
      { fileDate: january, id: 1 },
      { fileDate: january, id: 2 },
      { fileDate: february, id: 3 },
    ];
    const initial = buildPhotoGroupHeaders(photos.slice(0, 2), "en");
    const appended = buildPhotoGroupHeaders(photos, "en", 2, initial);

    expect(appended.map((header) => header.beforeIndex)).toEqual([0, 2]);
  });
});
