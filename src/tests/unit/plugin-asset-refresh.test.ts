import fs from "node:fs";
import os from "node:os";
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

let testRoot = "";
let firstImage = "";
let secondImage = "";
let firstVideo = "";
let secondVideo = "";

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
  testRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "ai-image-manager-plugin-assets-")
  );
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
  if (testRoot.startsWith(`${os.tmpdir()}${path.sep}`)) {
    fs.rmSync(testRoot, { force: true, recursive: true });
  }
});

beforeEach(() => {
  settingsState.values.clear();
  electronState.showOpenDialog.mockReset();
});

describe("PluginManager user asset refresh", () => {
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
