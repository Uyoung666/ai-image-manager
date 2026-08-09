import { describe, expect, it } from "vitest";
import { buildPhotoRemotePath } from "@/services/cloud/cloud-manager";

describe("cloud photo remote paths", () => {
  it("isolates same-basename photos by photo id", () => {
    expect(buildPhotoRemotePath(12, "photo.jpg")).toBe(
      "ai-image-manager/photos/12/photo.jpg"
    );
    expect(buildPhotoRemotePath(13, "photo.jpg")).not.toBe(
      buildPhotoRemotePath(12, "photo.jpg")
    );
  });

  it("normalizes a stored path to its basename", () => {
    expect(buildPhotoRemotePath(7, "folder\\photo.jpg")).toBe(
      "ai-image-manager/photos/7/photo.jpg"
    );
  });
});
