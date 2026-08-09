import { vi } from "vitest";
import {
  toDuelPreviewUrl,
  toHttpMediaUrl,
  toLocalMediaUrl,
  toPreviewUrl,
} from "@/utils/local-media-url";

vi.mock("@/utils/http-port", () => ({
  getHttpPort: vi.fn(async () => 45_678),
  getHttpPortSync: vi.fn(() => 45_678),
}));

describe("local media URL cache version", () => {
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
