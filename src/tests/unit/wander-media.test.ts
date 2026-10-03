import { beforeEach, describe, expect, it, vi } from "vitest";
import { getWanderSettings, setWanderSettings } from "@/actions/wander";
import { prepareWanderSession } from "@/components/wander/wander-media";
import {
  DEFAULT_WANDER_SETTINGS,
  parseWanderSettings,
  type WanderSession,
} from "@/types/wander";
import { preloadImagesWithConcurrency } from "@/utils/image-preloader";

const { getAllAppSettings, setAppSetting } = vi.hoisted(() => ({
  getAllAppSettings: vi.fn(),
  setAppSetting: vi.fn(),
}));
vi.mock("@/ipc/manager", () => ({
  ipc: { client: { settings: { getAllAppSettings, setAppSetting } } },
}));
vi.mock("@/utils/image-preloader", () => ({
  preloadImagesWithConcurrency: vi.fn(),
}));
vi.mock("@/utils/local-media-url", () => ({
  toLocalMediaUrl: (path: string) => `local://${path}`,
  toPreviewUrl: (path: string) => `preview://${path}`,
}));
const photo = {
  id: 1,
  filename: "a.jpg",
  path: "/a.jpg",
  thumbnailPath: "/a.webp",
  width: 800,
  height: 600,
  fileDate: 1,
  isIndexed: true,
  isFavorite: false,
};
const session: WanderSession = {
  mode: "theme",
  titleKey: "theme",
  photos: [photo],
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(preloadImagesWithConcurrency).mockResolvedValue({
    loaded: 1,
    failed: 0,
  });
  setAppSetting.mockResolvedValue({});
});
describe("wander preview preparation", () => {
  it("deduplicates photos and never requests the original when the thumbnail works", async () => {
    const result = await prepareWanderSession(
      { ...session, photos: [photo, photo] },
      () => false
    );
    expect(result.photos).toHaveLength(1);
    expect(result.previews).toEqual({ 1: "local:///a.webp" });
    expect(preloadImagesWithConcurrency).toHaveBeenCalledExactlyOnceWith(
      ["local:///a.webp"],
      4
    );
  });
  it("falls back from a broken thumbnail to a RAW preview", async () => {
    vi.mocked(preloadImagesWithConcurrency).mockResolvedValueOnce({
      loaded: 0,
      failed: 1,
    });
    const result = await prepareWanderSession(
      { ...session, photos: [{ ...photo, path: "/a.cr3" }] },
      () => false
    );
    expect(result.previews).toEqual({ 1: "preview:///a.cr3" });
    expect(preloadImagesWithConcurrency).toHaveBeenCalledTimes(2);
  });
  it("filters failed photos and does not enqueue work after cancellation", async () => {
    vi.mocked(preloadImagesWithConcurrency).mockResolvedValue({
      loaded: 0,
      failed: 1,
    });
    expect((await prepareWanderSession(session, () => false)).photos).toEqual(
      []
    );
    vi.mocked(preloadImagesWithConcurrency).mockClear();
    expect((await prepareWanderSession(session, () => true)).photos).toEqual(
      []
    );
    expect(preloadImagesWithConcurrency).not.toHaveBeenCalled();
  });
});
describe("wander presentation settings", () => {
  it("round-trips presentation and speed through the existing settings IPC", async () => {
    const settings = {
      ...DEFAULT_WANDER_SETTINGS,
      presentation: "slideshow" as const,
      flowSpeed: "fast" as const,
    };
    await setWanderSettings(settings);
    expect(setAppSetting).toHaveBeenCalledWith({
      key: "wander.presentation",
      value: "slideshow",
    });
    expect(setAppSetting).toHaveBeenCalledWith({
      key: "wander.flowSpeed",
      value: "fast",
    });
    getAllAppSettings.mockResolvedValue({
      settings: setAppSetting.mock.calls.map(([value]) => value),
    });
    expect(await getWanderSettings()).toEqual(settings);
  });
  it("uses gallery defaults for missing or corrupt fields and preserves idle preferences", () => {
    expect(
      parseWanderSettings([
        { key: "wander.enabled", value: "false" },
        { key: "wander.presentation", value: "bad" },
        { key: "wander.flowSpeed", value: "bad" },
      ])
    ).toEqual(DEFAULT_WANDER_SETTINGS);
    expect(
      parseWanderSettings([
        { key: "wander.enabled", value: "true" },
        { key: "wander.flowSpeed", value: "slow" },
      ])
    ).toMatchObject({
      enabled: true,
      presentation: "parallax",
      flowSpeed: "slow",
    });
  });
});
