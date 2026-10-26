import { vi } from "vitest";
import {
  toDuelPreviewUrl,
  toGalleryThumbnailUrl,
  toHttpMediaUrl,
  toLocalMediaUrl,
  toPreviewUrl,
} from "@/utils/local-media-url";

vi.mock("@/utils/http-port", () => ({
  getHttpPort: vi.fn(async () => 45_678),
  getHttpPortSync: vi.fn(() => 45_678),
}));

describe("local media URL cache version", () => {
  it("versions gallery policy separately from source identity and legacy paths", () => {
    const url = new URL(toGalleryThumbnailUrl(1, 256, "geometry", "identity"));
    expect(url.searchParams.get("gv")).toBe("2");
    expect(url.searchParams.get("rv")).toBe("identity");
    expect(url.searchParams.has("path")).toBe(false);
    expect(
      new URL(
        toGalleryThumbnailUrl(1, 256, "geometry", undefined, true)
      ).searchParams.get("select")
    ).toBe("1");
    const repair = new URL(
      toGalleryThumbnailUrl(1, 512, "geometry", "identity", false, true)
    );
    expect(repair.searchParams.get("repair")).toBe("1");
    expect(repair.searchParams.has("select")).toBe(false);
    expect(url.searchParams.has("repair")).toBe(false);
  });
  it("versions thumbnail and original image URLs", () => {
    expect(toLocalMediaUrl("C:\\photos\\one.webp")).toContain(
      "/thumbnail?path="
    );
    expect(toLocalMediaUrl("C:\\photos\\one.jpg")).toContain("/image?path=");
    expect(toLocalMediaUrl("C:\\photos\\one.jpg")).toContain("&v=2");
  });

  it("versions RAW and duel preview URLs", () => {
    expect(toPreviewUrl("C:\\photos\\one.cr3")).toContain("/preview?path=");
    expect(toPreviewUrl("C:\\photos\\one.cr3")).toContain("&v=2");
    expect(toDuelPreviewUrl("C:\\cache\\one.jpg")).toContain("&v=2");
  });

  it("versions asynchronously constructed media URLs", async () => {
    await expect(toHttpMediaUrl("C:\\photos\\one.jpg")).resolves.toContain(
      "&v=2"
    );
  });

  it("adds the HTTP media authentication token when preload provides one", () => {
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: { httpAuthToken: "test-token" },
    });

    expect(toLocalMediaUrl("C:\\photos\\one.jpg")).toContain(
      "&token=test-token"
    );
    Reflect.deleteProperty(window, "electronAPI");
  });
});
