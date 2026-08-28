import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  packPlugin,
  validatePlugin,
  validatePluginDirectory,
  validatePluginPackage,
} from "../../../scripts/plugin-cli.mjs";

let temporaryDirectory: string;

const EXTRA_FILE_ERROR_PATTERN = /extra file|unsupported file/i;
const HTML_ERROR_PATTERN = /HTML/i;
const LOCALE_VALUE_ERROR_PATTERN = /objects, arrays, or strings/i;

const manifest = {
  apiVersion: 3,
  author: { name: "Example Studio" },
  capabilities: ["locale"],
  description: {
    en: "Japanese UI translation.",
    "ja-JP": "日本語 UI 翻訳。",
  },
  engine: { minAppVersion: "2.0.0" },
  id: "com.example.japanese-locale",
  locale: {
    catalogVersion: "1.0.0",
    direction: "ltr",
    fallback: "en",
    mainFile: "locales/ja-JP/main.json",
    nativeName: "日本語",
    rendererFile: "locales/ja-JP/renderer.json",
    tag: "ja-JP",
  },
  manifestVersion: 3,
  name: { en: "Japanese", "ja-JP": "日本語" },
  version: "1.0.0",
};

async function createLocaleDirectory(name: string): Promise<string> {
  const directory = path.join(temporaryDirectory, name);
  const localeDirectory = path.join(directory, "locales", "ja-JP");
  await fs.mkdir(localeDirectory, { recursive: true });
  await fs.writeFile(
    path.join(directory, "plugin.json"),
    JSON.stringify(manifest),
    "utf8"
  );
  await fs.writeFile(
    path.join(localeDirectory, "renderer.json"),
    JSON.stringify({ close: "閉じる", count: "{{count}} 件" }),
    "utf8"
  );
  await fs.writeFile(
    path.join(localeDirectory, "main.json"),
    JSON.stringify({ tray: { open: "開く" } }),
    "utf8"
  );
  return directory;
}

describe("plugin v3 locale CLI", () => {
  beforeAll(async () => {
    temporaryDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "aim-plugin-cli-locale-")
    );
  });

  afterAll(async () => {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  });

  it("validates an unsigned developer locale directory and fixed layout", async () => {
    const directory = await createLocaleDirectory("unsigned");
    const result = await validatePluginDirectory(directory);

    expect(result.id).toBe(manifest.id);
    expect(result.locale?.tag).toBe("ja-JP");
    expect(result.signed).toBe(false);
    await expect(validatePlugin(directory)).resolves.toMatchObject({
      signed: false,
    });
  });

  it("signs locale packages from an external Ed25519 private-key path", async () => {
    const directory = await createLocaleDirectory("signed");
    const keyPath = path.join(temporaryDirectory, "release-key.pem");
    const output = path.join(temporaryDirectory, "signed-package");
    const { privateKey } = generateKeyPairSync("ed25519");
    await fs.writeFile(
      keyPath,
      privateKey.export({ format: "pem", type: "pkcs8" }),
      "utf8"
    );

    const first = await packPlugin(directory, {
      keyId: "test-release",
      out: output,
      signKey: keyPath,
    });
    const second = await packPlugin(directory, {
      keyId: "test-release",
      out: path.join(temporaryDirectory, "signed-package-2"),
      signKey: keyPath,
    });
    expect(first.signed).toBe(true);
    expect(first.entries).toContain("signature.json");
    expect(await fs.readFile(first.outputPath)).toEqual(
      await fs.readFile(second.outputPath)
    );
    const archive = await validatePluginPackage(first.outputPath);
    expect(archive.signed).toBe(true);
    expect(archive.manifest).toMatchObject({ manifestVersion: 3 });
  });

  it("rejects locale files outside the fixed renderer/main pair", async () => {
    const directory = await createLocaleDirectory("extra");
    await fs.writeFile(
      path.join(directory, "locales", "ja-JP", "extra.json"),
      JSON.stringify({ unsafe: "extra" }),
      "utf8"
    );
    await expect(validatePluginDirectory(directory)).rejects.toThrow(
      EXTRA_FILE_ERROR_PATTERN
    );
  });

  it("rejects HTML and scalar locale values", async () => {
    const directory = await createLocaleDirectory("unsafe");
    await fs.writeFile(
      path.join(directory, "locales", "ja-JP", "renderer.json"),
      JSON.stringify({ html: "<b>unsafe</b>" }),
      "utf8"
    );
    await expect(validatePluginDirectory(directory)).rejects.toThrow(
      HTML_ERROR_PATTERN
    );
    await fs.writeFile(
      path.join(directory, "locales", "ja-JP", "renderer.json"),
      JSON.stringify({ count: 1 }),
      "utf8"
    );
    await expect(validatePluginDirectory(directory)).rejects.toThrow(
      LOCALE_VALUE_ERROR_PATTERN
    );
  });
});
