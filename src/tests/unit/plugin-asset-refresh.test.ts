import fs from "node:fs";
import path from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  NEBULA_GLASS_MANIFEST,
  NEBULA_GLASS_PLUGIN_ID,
} from "@/plugins/builtins/nebula-glass-manifest";

const electronState = vi.hoisted(() => ({
  showOpenDialog: vi.fn(),
  userData: "",
}));

const settingsState = vi.hoisted(() => ({
  values: new Map<string, string>(),
}));

vi.mock("electron", () => ({
  app: {
    getPath: () => electronState.userData,
    getVersion: () => "2.0.0",
  },
  dialog: {
    showOpenDialog: electronState.showOpenDialog,
  },
  protocol: {
    handle: vi.fn(),
  },
}));

vi.mock("@/services/settings-manager", () => ({
  getSetting: (key: string) => settingsState.values.get(key) ?? null,
  setSetting: (key: string, value: string) => {
    settingsState.values.set(key, value);
  },
}));

import { PluginManager } from "@/services/plugin-manager";
import { TestRuntime } from "../helpers/test-runtime";

let testRoot = "";
let firstImage = "";
let secondImage = "";
let firstVideo = "";
let secondVideo = "";
let runtime: TestRuntime;

function writePng(filePath: string, marker: number): void {
  const contents = Buffer.alloc(32, marker);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(contents);
  fs.writeFileSync(filePath, contents);
}

function writeMp4(filePath: string, marker: number): void {
  const contents = Buffer.alloc(32, marker);
  contents.writeUInt32BE(24, 0);
  contents.write("ftyp", 4, "ascii");
  contents.write("isom", 8, "ascii");
  fs.writeFileSync(filePath, contents);
}

function assetUrl(
  snapshot: Awaited<ReturnType<PluginManager["list"]>>,
  settingId: string
): string {
  const plugin = snapshot.plugins.find(
    (record) => record.manifest.id === NEBULA_GLASS_PLUGIN_ID
  );
  const url = plugin?.assetUrls[settingId];
  if (!url) {
    throw new Error(`Missing asset URL for ${settingId}`);
  }
  return url;
}

beforeAll(() => {
  runtime = new TestRuntime("nebula-plugin-assets");
  testRoot = runtime.root;
  electronState.userData = path.join(testRoot, "user-data");
  firstImage = path.join(testRoot, "first.png");
  secondImage = path.join(testRoot, "second.png");
  firstVideo = path.join(testRoot, "first.mp4");
  secondVideo = path.join(testRoot, "second.mp4");
  writePng(firstImage, 1);
  writePng(secondImage, 2);
  writeMp4(firstVideo, 3);
  writeMp4(secondVideo, 4);
});

afterAll(() => {
  runtime.cleanup();
});

beforeEach(() => {
  settingsState.values.clear();
  electronState.showOpenDialog.mockReset();
});

describe("PluginManager user asset refresh", () => {
  it("accepts binary WebM headers and rejects their ASCII-masked lookalike", async () => {
    const manager = new PluginManager([NEBULA_GLASS_MANIFEST]);
    const video = path.join(testRoot, "binary.webm");
    fs.writeFileSync(
      video,
      Buffer.from([0x1a, 0x45, 0xdf, 0xa3, ...new Array(28).fill(0)])
    );
    electronState.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: [video],
    });
    const selected = assetUrl(
      await manager.selectAsset(NEBULA_GLASS_PLUGIN_ID, "wallpaperVideo"),
      "wallpaperVideo"
    );
    const response = await manager.resolveUserAsset(selected, "bytes=0-3");
    expect(response.status).toBe(206);
    expect(response.headers.get("content-type")).toBe("video/webm");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(
      Buffer.from([0x1a, 0x45, 0xdf, 0xa3])
    );
    const fake = path.join(testRoot, "lookalike.webm");
    fs.writeFileSync(
      fake,
      Buffer.from([0x1a, 0x45, 0x5f, 0x23, ...new Array(28).fill(0)])
    );
    electronState.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: [fake],
    });
    await expect(
      manager.selectAsset(NEBULA_GLASS_PLUGIN_ID, "wallpaperVideo")
    ).rejects.toThrow("MIME");
  });
  it("changes the image URL after selecting a replacement", async () => {
    const manager = new PluginManager([NEBULA_GLASS_MANIFEST]);
    electronState.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: [firstImage],
    });
    const first = await manager.selectAsset(
      NEBULA_GLASS_PLUGIN_ID,
      "wallpaper"
    );
    electronState.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: [secondImage],
    });
    const second = await manager.selectAsset(
      NEBULA_GLASS_PLUGIN_ID,
      "wallpaper"
    );

    const firstUrl = assetUrl(first, "wallpaper");
    const secondUrl = assetUrl(second, "wallpaper");
    expect(firstUrl).toContain("?revision=");
    expect(secondUrl).not.toBe(firstUrl);
    expect(secondUrl).not.toContain(encodeURIComponent(secondImage));
  });

  it("changes the video URL and serves byte ranges for playback", async () => {
    const manager = new PluginManager([NEBULA_GLASS_MANIFEST]);
    electronState.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: [firstVideo],
    });
    const first = await manager.selectAsset(
      NEBULA_GLASS_PLUGIN_ID,
      "wallpaperVideo"
    );
    electronState.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: [secondVideo],
    });
    const second = await manager.selectAsset(
      NEBULA_GLASS_PLUGIN_ID,
      "wallpaperVideo"
    );

    const firstUrl = assetUrl(first, "wallpaperVideo");
    const secondUrl = assetUrl(second, "wallpaperVideo");
    expect(secondUrl).not.toBe(firstUrl);

    const response = await manager.resolveUserAsset(secondUrl, "bytes=4-11");
    expect(response.status).toBe(206);
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-range")).toBe("bytes 4-11/32");
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(Buffer.from(await response.arrayBuffer()).toString("ascii")).toBe(
      "ftypisom"
    );
  });
});
