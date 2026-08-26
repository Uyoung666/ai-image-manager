import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deflateRawSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  packPlugin,
  validatePlugin,
  validatePluginDirectory,
  validatePluginPackage,
} from "../../../scripts/plugin-cli.mjs";

const exampleDirectory = path.resolve(
  import.meta.dirname,
  "../../../examples/plugins/layered-aurora"
);
let temporaryDirectory: string;
const EXTRA_FILE_ERROR = /extra file|unsupported asset/i;
const MANIFEST_VERSION_ERROR = /both be 2/i;
const UNSAFE_PATH_ERROR = /unsafe path/i;
const UNSAFE_COLOR_ERROR = /safe literal color/i;
const UNSAFE_TOKEN_ERROR = /safe color token/i;
const COLOR_BINDING_ERROR = /safe literal color|must be a string/i;
const TOKEN_BINDING_ERROR = /binding must target color/i;
const FILTER_RANGE_ERROR = /outside its safe range/i;

async function copyExample(name: string): Promise<string> {
  const destination = path.join(temporaryDirectory, name);
  await fs.cp(exampleDirectory, destination, { recursive: true });
  return destination;
}

function u16(value: number): Buffer {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value, 0);
  return buffer;
}

function u32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value, 0);
  return buffer;
}

/** Build the smallest possible ZIP so the path check is tested independently
 * of archiver's path sanitization. */
function unsafeZip(entryName: string): Buffer {
  const name = Buffer.from(entryName, "utf8");
  const payload = Buffer.from("not a plugin");
  const compressed = deflateRawSync(payload);
  const local = Buffer.concat([
    Buffer.from("PK\x03\x04", "binary"),
    u16(20),
    u16(0),
    u16(8),
    u16(0),
    u16(0),
    u32(0),
    u32(0),
    u32(compressed.length),
    u32(payload.length),
    u16(name.length),
    u16(0),
    name,
    compressed,
  ]);
  const central = Buffer.concat([
    Buffer.from("PK\x01\x02", "binary"),
    u16(20),
    u16(20),
    u16(0),
    u16(8),
    u16(0),
    u16(0),
    u32(0),
    u32(0),
    u32(compressed.length),
    u32(payload.length),
    u16(name.length),
    u16(0),
    u16(0),
    u16(0),
    u16(0),
    u32(0),
    u32(0),
    name,
  ]);
  const end = Buffer.concat([
    Buffer.from("PK\x05\x06", "binary"),
    u16(0),
    u16(0),
    u16(1),
    u16(1),
    u32(central.length),
    u32(local.length),
    u16(0),
  ]);
  return Buffer.concat([local, central, end]);
}

describe("plugin v2 developer CLI", () => {
  beforeAll(async () => {
    temporaryDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "aim-plugin-cli-test-")
    );
  });

  afterAll(async () => {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  });

  it("validates and packs the layered Aurora example deterministically", async () => {
    const result = await validatePluginDirectory(exampleDirectory);
    expect(result.id).toBe("com.aiimagemanager.layered-aurora");
    expect(result.version).toBe("1.0.0");
    const firstOutput = path.join(temporaryDirectory, "first");
    const secondOutput = path.join(temporaryDirectory, "second");
    const first = await packPlugin(exampleDirectory, { out: firstOutput });
    const second = await packPlugin(exampleDirectory, { out: secondOutput });
    expect(await fs.readFile(first.outputPath)).toEqual(
      await fs.readFile(second.outputPath)
    );
    const archiveResult = await validatePluginPackage(first.outputPath);
    expect(archiveResult.id).toBe(result.id);
    expect(archiveResult.assets).toContain("assets/sample.png");
  });

  it("rejects an extra file in the source directory", async () => {
    const directory = await copyExample("extra-file");
    await fs.writeFile(path.join(directory, "README.md"), "not package data");
    await expect(validatePlugin(directory)).rejects.toThrow(EXTRA_FILE_ERROR);
  });

  it("rejects an invalid manifest", async () => {
    const directory = await copyExample("invalid-manifest");
    const manifestPath = path.join(directory, "plugin.json");
    const manifest = JSON.parse(
      await fs.readFile(manifestPath, "utf8")
    ) as Record<string, unknown>;
    manifest.manifestVersion = 1;
    await fs.writeFile(manifestPath, JSON.stringify(manifest), "utf8");
    await expect(validatePluginDirectory(directory)).rejects.toThrow(
      MANIFEST_VERSION_ERROR
    );
  });

  it.each([
    "#fff",
    "rgb(1 2 3)",
    "hsl(1 2% 3%)",
    "url(https://example.com)",
  ])("rejects unsafe color literal %s", async (color) => {
    const directory = await copyExample(`invalid-color-${color.length}`);
    const themePath = path.join(directory, "theme.json");
    const theme = JSON.parse(await fs.readFile(themePath, "utf8")) as {
      layers: Record<string, unknown>[];
    };
    theme.layers[0].color = color;
    await fs.writeFile(themePath, JSON.stringify(theme), "utf8");
    await expect(validatePluginDirectory(directory)).rejects.toThrow(
      UNSAFE_COLOR_ERROR
    );
  });

  it("rejects scalar theme tokens", async () => {
    const directory = await copyExample("invalid-scalar-token");
    const themePath = path.join(directory, "theme.json");
    const theme = JSON.parse(await fs.readFile(themePath, "utf8")) as Record<
      string,
      unknown
    >;
    theme.tokens = { background: "1px" };
    await fs.writeFile(themePath, JSON.stringify(theme), "utf8");
    await expect(validatePluginDirectory(directory)).rejects.toThrow(
      UNSAFE_TOKEN_ERROR
    );
  });

  it("matches v2 color and token binding types", async () => {
    const invalidColor = await copyExample("invalid-color-binding");
    const manifestPath = path.join(invalidColor, "plugin.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
      settings: Record<string, unknown>[];
    };
    const colorSetting = manifest.settings.find(
      (setting) => setting.id === "accentColor"
    );
    if (!colorSetting) {
      throw new Error("fixture is missing color setting");
    }
    colorSetting.defaultValue = { setting: "accentColor" };
    await fs.writeFile(manifestPath, JSON.stringify(manifest), "utf8");
    await expect(validatePluginDirectory(invalidColor)).rejects.toThrow(
      COLOR_BINDING_ERROR
    );

    const invalidToken = await copyExample("invalid-token-binding");
    const themePath = path.join(invalidToken, "theme.json");
    const theme = JSON.parse(await fs.readFile(themePath, "utf8")) as Record<
      string,
      unknown
    >;
    theme.tokens = { background: { setting: "auroraIntensity" } };
    await fs.writeFile(themePath, JSON.stringify(theme), "utf8");
    await expect(validatePluginDirectory(invalidToken)).rejects.toThrow(
      TOKEN_BINDING_ERROR
    );
  });

  it("enforces v2 layer and material filter ranges", async () => {
    const directory = await copyExample("invalid-filter-range");
    const themePath = path.join(directory, "theme.json");
    const theme = JSON.parse(await fs.readFile(themePath, "utf8")) as {
      layers: Record<string, unknown>[];
    };
    theme.layers[0].brightness = 3;
    await fs.writeFile(themePath, JSON.stringify(theme), "utf8");
    await expect(validatePluginDirectory(directory)).rejects.toThrow(
      FILTER_RANGE_ERROR
    );
  });

  it("rejects traversal names in an existing ZIP", async () => {
    const archivePath = path.join(temporaryDirectory, "traversal.aim-plugin");
    await fs.writeFile(archivePath, unsafeZip("../escape.txt"));
    await expect(validatePlugin(archivePath)).rejects.toThrow(
      UNSAFE_PATH_ERROR
    );
  });
});
