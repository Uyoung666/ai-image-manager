// @vitest-environment node
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { writeUpdateMetadata } from "@/services/update-atomic-file";
import { TestRuntime } from "../helpers/test-runtime";

let runtime: TestRuntime;
let originalPlatform: string;
beforeEach(() => {
  originalPlatform = process.platform;
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: "win32",
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: originalPlatform,
  });
  runtime.cleanup();
});
it("replaces metadata completely and leaves no staging file", async () => {
  runtime = new TestRuntime("update-atomic");
  const file = path.join(runtime.root, "RELEASES");
  await fs.writeFile(file, "old");
  await writeUpdateMetadata(file, "verified new metadata");
  expect(await fs.readFile(file, "utf8")).toBe("verified new metadata");
  expect(
    (await fs.readdir(runtime.root)).some((name) => name.endsWith(".tmp"))
  ).toBe(false);
});
it("retains the previous metadata when replacement is denied", async () => {
  runtime = new TestRuntime("update-atomic");
  const file = path.join(runtime.root, "RELEASES");
  await fs.writeFile(file, "old");
  const rename = vi
    .spyOn(fs, "rename")
    .mockRejectedValue(Object.assign(new Error("denied"), { code: "EPERM" }));
  await expect(writeUpdateMetadata(file, "new")).rejects.toThrow("denied");
  expect(rename).toHaveBeenCalledTimes(4);
  expect(await fs.readFile(file, "utf8")).toBe("old");
  expect(
    (await fs.readdir(runtime.root)).some((name) => name.endsWith(".tmp"))
  ).toBe(false);
});

it.each([
  "EPERM",
  "EBUSY",
])("retries a transient Windows %s without removing old metadata", async (code) => {
  runtime = new TestRuntime("update-atomic");
  const file = path.join(runtime.root, "RELEASES");
  await fs.writeFile(file, "old");
  const originalRename = fs.rename.bind(fs);
  const rename = vi
    .spyOn(fs, "rename")
    .mockImplementationOnce(async () => {
      expect(await fs.readFile(file, "utf8")).toBe("old");
      throw Object.assign(new Error("sharing violation"), { code });
    })
    .mockImplementation(originalRename);
  await writeUpdateMetadata(file, "new");
  expect(rename).toHaveBeenCalledTimes(2);
  expect(await fs.readFile(file, "utf8")).toBe("new");
  expect(
    (await fs.readdir(runtime.root)).some((name) => name.endsWith(".tmp"))
  ).toBe(false);
});

it.each([
  "EIO",
  "EACCES",
])("does not retry a permanent %s error", async (code) => {
  runtime = new TestRuntime("update-atomic");
  const file = path.join(runtime.root, "RELEASES");
  await fs.writeFile(file, "old");
  const rename = vi
    .spyOn(fs, "rename")
    .mockRejectedValue(Object.assign(new Error("permanent"), { code }));
  await expect(writeUpdateMetadata(file, "new")).rejects.toThrow("permanent");
  expect(rename).toHaveBeenCalledOnce();
  expect(await fs.readFile(file, "utf8")).toBe("old");
});
