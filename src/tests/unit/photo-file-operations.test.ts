import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { movePhotoFile } from "@/services/photo-file-operations";

describe("movePhotoFile", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("moves only the source photo so locked thumbnails cannot block rename", () => {
    const renameSync = vi
      .spyOn(fs, "renameSync")
      .mockImplementation(() => undefined);

    expect(
      movePhotoFile("D:/photos/original.jpg", "D:/photos/renamed.jpg")
    ).toEqual([
      { from: "D:/photos/original.jpg", to: "D:/photos/renamed.jpg" },
    ]);
    expect(renameSync).toHaveBeenCalledOnce();
    expect(renameSync).toHaveBeenCalledWith(
      "D:/photos/original.jpg",
      "D:/photos/renamed.jpg"
    );
  });
});
