import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  checkJapaneseLocale,
  verifyLocalePackageSignature,
} from "../../../scripts/locale-release.mjs";
import {
  packPlugin,
  validatePluginPackage,
} from "../../../scripts/plugin-cli.mjs";

let root;
let plugin;
let privatePath;
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const trustedKeys = { test: publicKey.export({ type: "spki", format: "pem" }) };

beforeAll(async () => {
  await fs.mkdir(path.resolve(".cache"), { recursive: true });
  root = await fs.mkdtemp(path.resolve(".cache/locale-release-"));
  plugin = path.join(root, "external-plugins/japanese-locale");
  await fs.mkdir(path.join(plugin, "locales/ja-JP"), { recursive: true });
  await fs.copyFile(
    path.resolve("external-plugins/japanese-locale/plugin.json"),
    path.join(plugin, "plugin.json")
  );
  await fs.writeFile(
    path.join(plugin, "locales/ja-JP/renderer.json"),
    JSON.stringify({ close: "閉じる" })
  );
  await fs.writeFile(
    path.join(plugin, "locales/ja-JP/main.json"),
    JSON.stringify({ quit: "終了" })
  );
  privatePath = path.join(root, "test-private.pem");
  await fs.writeFile(
    privatePath,
    privateKey.export({ type: "pkcs8", format: "pem" })
  );
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("official locale package verification", () => {
  it("verifies signed bytes, rejects unknown keys, missing signatures and tampering", async () => {
    const packed = await packPlugin(plugin, {
      out: path.join(root, "out"),
      signingKeyPath: privatePath,
      keyId: "test",
    });
    const result = await validatePluginPackage(packed.outputPath);
    expect(verifyLocalePackageSignature(result, trustedKeys)).toBe("test");
    expect(() => verifyLocalePackageSignature(result, {})).toThrow();
    const tampered = { ...result, files: new Map(result.files) };
    tampered.files.set(
      "locales/ja-JP/main.json",
      Buffer.from('{"quit":"changed"}')
    );
    expect(() => verifyLocalePackageSignature(tampered, trustedKeys)).toThrow();
    tampered.files.delete("signature.json");
    expect(() => verifyLocalePackageSignature(tampered, trustedKeys)).toThrow();
    const second = await packPlugin(plugin, {
      out: path.join(root, "again"),
      signingKeyPath: privatePath,
      keyId: "test",
    });
    expect(await fs.readFile(second.outputPath)).toEqual(
      await fs.readFile(packed.outputPath)
    );
  });

  it("rejects a plugin version that does not match the host before publishing", async () => {
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ version: "99.0.0" })
    );
    await expect(checkJapaneseLocale(root)).rejects.toThrow(
      "must match the application"
    );
  });
});
