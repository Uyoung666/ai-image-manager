// @vitest-environment node
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import type { Archiver } from "archiver";

const { ZipArchive } = createRequire(import.meta.url)("archiver") as {
  ZipArchive: new (options: { zlib: { level: number } }) => Archiver;
};

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubUpdateManifest } from "@/services/github-update";
import {
  assertUpdateDownloadSpace,
  assertUpdateInstallSpace,
  assertUpdateSpace,
  cleanupUpdateCache,
  invalidateUpdatePackage,
  UPDATE_CACHE_MAX_AGE_MS,
  UPDATE_SPACE_RESERVE,
  updatePackageExpandedSize,
} from "@/services/update-storage";
import { TestRuntime } from "../helpers/test-runtime";

const log = vi.hoisted(() => vi.fn());
vi.mock("@/services/update-error", () => ({ recordUpdateError: log }));
let runtime: TestRuntime;
beforeEach(() => {
  runtime = new TestRuntime("update-storage");
  vi.clearAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
  runtime.cleanup();
});

function available(bytes: number) {
  vi.spyOn(fs, "statfs").mockResolvedValue({
    bavail: BigInt(bytes),
    bsize: 1n,
  } as Awaited<ReturnType<typeof fs.statfs>>);
}

function manifest(version: string): GitHubUpdateManifest {
  const base = `https://github.com/Uyoung666/ai-image-manager/releases/download/v${version}`;
  const filename = `ai-image-manager-${version}-full.nupkg`;
  return {
    schemaVersion: 1,
    repository: "Uyoung666/ai-image-manager",
    platform: "win32-x64",
    version,
    tag: `v${version}`,
    assetsBaseUrl: base,
    releaseUrl: `https://github.com/Uyoung666/ai-image-manager/releases/tag/v${version}`,
    packages: {
      full: {
        filename,
        size: 100,
        sha1: "0".repeat(40),
        sha256: "0".repeat(64),
        url: `${base}/${filename}`,
      },
    },
  };
}

async function cachedVersion(version: string, extra: string[] = []) {
  const directory = path.join(runtime.root, version);
  const value = manifest(version);
  await fs.mkdir(directory);
  const files = [
    "update-manifest.json",
    "RELEASES",
    value.packages.full.filename,
    `${value.packages.full.filename}.download`,
    ...extra,
  ];
  for (const file of files) {
    await fs.writeFile(
      path.join(directory, file),
      file === "update-manifest.json" ? JSON.stringify(value) : "test"
    );
    const old = new Date(Date.now() - UPDATE_CACHE_MAX_AGE_MS - 1000);
    await fs.utimes(path.join(directory, file), old, old);
  }
  return directory;
}

describe("space budgets", () => {
  it("combines paths on the same volume and reserves space only once", async () => {
    available(UPDATE_SPACE_RESERVE + 299);
    await expect(
      assertUpdateSpace([
        { directory: runtime.root, bytes: 100 },
        { directory: path.join(runtime.root, "not-created"), bytes: 200 },
      ])
    ).rejects.toThrow("UPDATE_DISK_SPACE");
    available(UPDATE_SPACE_RESERVE + 300);
    await expect(
      assertUpdateSpace([{ directory: runtime.root, bytes: 300 }])
    ).resolves.toBeUndefined();
  });

  it("checks independent volumes separately", async () => {
    const second = path.join(runtime.root, "second");
    await fs.mkdir(second);
    available(UPDATE_SPACE_RESERVE + 200);
    const stat = fs.stat.bind(fs);
    vi.spyOn(fs, "stat").mockImplementation(async (file, options) => {
      const value = await stat(file, options);
      const device = String(file) === second ? 2 : 1;
      value.dev = typeof value.dev === "bigint" ? BigInt(device) : device;
      return value;
    });
    await expect(
      assertUpdateSpace([
        { directory: runtime.root, bytes: 200 },
        { directory: second, bytes: 200 },
      ])
    ).resolves.toBeUndefined();
  });

  it("deducts partial bytes but never trusts an oversized partial", async () => {
    const info = manifest("2.2.4").packages.full;
    const destination = path.join(runtime.root, info.filename);
    await fs.writeFile(`${destination}.download`, Buffer.alloc(80));
    available(UPDATE_SPACE_RESERVE + 20);
    await expect(
      assertUpdateDownloadSpace(info, destination)
    ).resolves.toBeUndefined();
    await fs.writeFile(`${destination}.download`, Buffer.alloc(101));
    await expect(assertUpdateDownloadSpace(info, destination)).rejects.toThrow(
      "UPDATE_DISK_SPACE"
    );
  });

  it("logs unavailable space queries and allows the actual filesystem operation", async () => {
    vi.spyOn(fs, "statfs").mockRejectedValue(new Error("not supported"));
    await expect(
      assertUpdateSpace([{ directory: runtime.root, bytes: 100 }])
    ).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.any(Error), "query-update-space");
  });

  it("reads the full ZIP expanded size and budgets both installation and temporary work", async () => {
    const file = path.join(runtime.root, "full.nupkg");
    const archive = new ZipArchive({ zlib: { level: 9 } });
    const output = createWriteStream(file);
    const completed = new Promise<void>((resolve, reject) => {
      output.on("close", resolve);
      output.on("error", reject);
      archive.on("error", reject);
    });
    archive.pipe(output);
    archive.append(Buffer.alloc(1000), { name: "lib/net45/app.bin" });
    await archive.finalize();
    await completed;
    expect(await updatePackageExpandedSize(file)).toBe(1000);
    available(UPDATE_SPACE_RESERVE + 2099);
    await expect(
      assertUpdateInstallSpace({
        packagePath: file,
        method: "full",
        fullSize: 100,
        applicationDirectory: runtime.root,
        installRoot: runtime.root,
        temporaryDirectory: runtime.root,
      })
    ).rejects.toThrow("UPDATE_DISK_SPACE");
  });

  it("estimates delta work from the larger of installed bytes and three full packages", async () => {
    const application = path.join(runtime.root, "app");
    await fs.mkdir(application);
    await fs.writeFile(path.join(application, "app.bin"), Buffer.alloc(400));
    available(UPDATE_SPACE_RESERVE + 899);
    await expect(
      assertUpdateInstallSpace({
        packagePath: "unused",
        method: "delta",
        fullSize: 100,
        applicationDirectory: application,
        installRoot: runtime.root,
        temporaryDirectory: runtime.root,
      })
    ).rejects.toThrow("UPDATE_DISK_SPACE");
  });
});

describe("cache retention", () => {
  it("removes only expired known files and retains active, recent and unknown files", async () => {
    runtime.retain();
    const old = await cachedVersion("2.2.0", [
      "user-note.txt",
      "user.csv",
      "user.xlsx",
    ]);
    const active = await cachedVersion("2.2.1");
    const recent = await cachedVersion("2.2.2");
    await fs.utimes(path.join(recent, "RELEASES"), new Date(), new Date());
    await cleanupUpdateCache(
      runtime.root,
      () => new Set(["2.2.1"]),
      () => true
    );
    expect(await fs.readdir(old)).toEqual(
      expect.arrayContaining(["user-note.txt", "user.csv", "user.xlsx"])
    );
    expect(await fs.readdir(old)).toHaveLength(3);
    expect(await fs.readdir(active)).toHaveLength(4);
    expect(await fs.readdir(recent)).toHaveLength(4);
    // Protected spreadsheets are intentionally retained; TestRuntime must retain this fixture.
  });

  it("stops when an update begins and does not follow a junction outside the cache", async () => {
    const target = await cachedVersion("2.2.0");
    await cleanupUpdateCache(
      runtime.root,
      () => new Set(),
      () => false
    );
    expect(await fs.readdir(target)).toHaveLength(4);
    const link = path.join(runtime.root, "2.2.1");
    await fs.mkdir(link);
    const lstat = fs.lstat.bind(fs);
    vi.spyOn(fs, "lstat").mockImplementation(async (file, options) => {
      const stat = await lstat(file, options);
      if (String(file) === link) {
        stat.isSymbolicLink = () => true;
      }
      return stat;
    });
    await cleanupUpdateCache(
      runtime.root,
      () => new Set(["2.2.0"]),
      () => true
    );
    expect(await fs.readdir(target)).toHaveLength(4);
    expect(log).toHaveBeenCalledWith(
      expect.any(Error),
      "cleanup-update-version"
    );
  });

  it("preserves Temp contents and rejects package paths that escape the cache", async () => {
    runtime.retain();
    const protectedRoot = path.join(runtime.root, "Temp");
    await fs.mkdir(protectedRoot);
    await fs.writeFile(path.join(protectedRoot, "keep.txt"), "keep");
    await cleanupUpdateCache(
      protectedRoot,
      () => new Set(),
      () => true
    );
    expect(
      await fs.readFile(path.join(protectedRoot, "keep.txt"), "utf8")
    ).toBe("keep");
    await expect(
      invalidateUpdatePackage(runtime.root, {
        ...manifest("2.2.4").packages.full,
        filename: "../outside.nupkg",
      })
    ).rejects.toThrow("Invalid update package path");
    // Temp is protected and remains for inspection.
  });

  it("treats deletion failures as best effort", async () => {
    await cachedVersion("2.2.0");
    vi.spyOn(fs, "unlink").mockRejectedValue(new Error("EACCES"));
    await expect(
      cleanupUpdateCache(
        runtime.root,
        () => new Set(),
        () => true
      )
    ).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(
      expect.any(Error),
      "cleanup-update-version"
    );
  });
});
