import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  computeFullFileHashSync,
  computeSampleFileHashSync,
  FULL_FILE_HASH_VERSION,
  filesHaveSameBytesSync,
} from "@/services/file-hash";

describe("full duplicate file hashing", () => {
  let root: string;
  let firstPath: string;
  let changedPath: string;
  let copyPath: string;

  beforeAll(() => {
    root = fs.mkdtempSync(
      path.join(process.cwd(), ".cache", "duplicate-file-hash-test-")
    );
    firstPath = path.join(root, "first.bin");
    changedPath = path.join(root, "changed.bin");
    copyPath = path.join(root, "copy.bin");

    const first = Buffer.alloc(16 * 1024, 0x11);
    const changed = Buffer.from(first);
    changed.fill(0xee, 8 * 1024, 9 * 1024);
    fs.writeFileSync(firstPath, first);
    fs.writeFileSync(changedPath, changed);
    fs.copyFileSync(firstPath, copyPath);
  });

  afterAll(() => {
    fs.rmSync(root, { force: true, recursive: true });
  });

  it("hashes the complete file instead of only matching head and tail bytes", () => {
    expect(FULL_FILE_HASH_VERSION).toBe("sha256-full-v1");
    expect(computeSampleFileHashSync(firstPath)).toBe(
      computeSampleFileHashSync(changedPath)
    );
    expect(computeFullFileHashSync(firstPath)).not.toBe(
      computeFullFileHashSync(changedPath)
    );
    expect(filesHaveSameBytesSync(firstPath, changedPath)).toBe(false);
  });

  it("confirms byte equality after equal full hashes", () => {
    expect(computeFullFileHashSync(firstPath)).toBe(
      computeFullFileHashSync(copyPath)
    );
    expect(filesHaveSameBytesSync(firstPath, copyPath)).toBe(true);
  });
});
