import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256File } from "../../../scripts/release/checksums.mjs";
import {
  localeFilename,
  localeReportFilename,
  validateLocaleSmoke,
  verifyLocaleRelease,
} from "../../../scripts/release/locale.mjs";

let root;
const identity = {
  localeRequired: true,
  version: "2.3.0",
  tag: "v2.3.0",
  commit: "a".repeat(40),
};
let report;

beforeAll(async () => {
  await fs.mkdir(path.resolve(".cache"), { recursive: true });
  root = await fs.mkdtemp(path.resolve(".cache/locale-bundle-"));
  await fs.writeFile(
    path.join(root, localeFilename(identity.version)),
    "immutable fixture package"
  );
  report = {
    schemaVersion: 1,
    status: "passed",
    signature: "verified",
    pluginId: "com.aiimagemanager.japanese-locale",
    appVersion: identity.version,
    pluginVersion: identity.version,
    minimumAppVersion: identity.version,
    sourceCommit: identity.commit,
    packageSha256: await sha256File(
      path.join(root, localeFilename(identity.version))
    ),
    signerKeyId: "uyoung-locale-release-1",
    sourceCatalogSha256: "b".repeat(64),
    reviewSha256: "c".repeat(64),
    total: 2081,
  };
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("mandatory Japanese release evidence", () => {
  it("rejects missing, stale or failed reports and preserves historical compatibility", async () => {
    await expect(verifyLocaleRelease(root, identity)).rejects.toThrow();
    for (const patch of [
      { appVersion: "2.2.0" },
      { sourceCommit: "d".repeat(40) },
      { status: "failed" },
      { packageSha256: "0".repeat(64) },
      { minimumAppVersion: "1.0.0" },
    ]) {
      await fs.writeFile(
        path.join(root, localeReportFilename(identity.version)),
        JSON.stringify({ ...report, ...patch })
      );
      await expect(verifyLocaleRelease(root, identity)).rejects.toThrow();
    }
    await fs.writeFile(
      path.join(root, localeReportFilename(identity.version)),
      JSON.stringify(report)
    );
    await expect(verifyLocaleRelease(root, identity)).resolves.toHaveProperty(
      "plugin",
      localeFilename(identity.version)
    );
    await expect(
      verifyLocaleRelease(root, { ...identity, localeRequired: false })
    ).resolves.toBeNull();
  });

  it("binds installer verification to both the exact app ZIP and plugin bytes", () => {
    const manifest = {
      ...identity,
      files: [
        {
          relativePath: `files/${localeFilename(identity.version)}`,
          sha256: "plugin",
        },
        { relativePath: `files/app-${identity.version}.zip`, sha256: "app" },
        {
          relativePath: "evidence/locale-baseline.aim-plugin",
          sha256: "baseline",
        },
      ],
    };
    const smoke = {
      localeSmoke: "passed",
      localePackageSha256: "plugin",
      localeAppZipSha256: "app",
      localeBaselineSha256: "baseline",
    };
    expect(() => validateLocaleSmoke({}, manifest)).toThrow();
    expect(() =>
      validateLocaleSmoke({ ...smoke, localePackageSha256: "other" }, manifest)
    ).toThrow();
    expect(() =>
      validateLocaleSmoke({ ...smoke, localeAppZipSha256: "other" }, manifest)
    ).toThrow();
    expect(() => validateLocaleSmoke(smoke, manifest)).not.toThrow();
  });
});
