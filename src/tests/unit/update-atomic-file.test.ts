// @vitest-environment node
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { writeUpdateMetadata } from "@/services/update-atomic-file";
import { TestRuntime } from "../helpers/test-runtime";

let runtime: TestRuntime;
afterEach(() => {
  vi.restoreAllMocks();
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
  vi.spyOn(fs, "rename").mockRejectedValue(
    Object.assign(new Error("denied"), { code: "EPERM" })
  );
  await expect(writeUpdateMetadata(file, "new")).rejects.toThrow("denied");
  expect(await fs.readFile(file, "utf8")).toBe("old");
  expect(
    (await fs.readdir(runtime.root)).some((name) => name.endsWith(".tmp"))
  ).toBe(false);
});
