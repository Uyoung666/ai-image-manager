import { describe, expect, it } from "vitest";
import {
  canPaginateGalleryPhotos,
  getDisplayedSequenceMode,
} from "@/utils/gallery-view-state";

describe("gallery view state", () => {
  it("shows already loaded sequences immediately after switching modes", () => {
    expect(getDisplayedSequenceMode("sequences", true)).toBe("sequences");
    expect(getDisplayedSequenceMode("sequences", false)).toBe("photos");
  });

  it("keeps photo pagination enabled while a detail panel is handled separately", () => {
    expect(canPaginateGalleryPhotos("photos", true)).toBe(true);
    expect(canPaginateGalleryPhotos("photos", false)).toBe(false);
    expect(canPaginateGalleryPhotos("sequences", true)).toBe(false);
  });
});
