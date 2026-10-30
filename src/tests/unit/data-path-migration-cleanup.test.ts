/** @vitest-environment node */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  projectPreviewMigrationOwnership,
  removeMigratedDataDirectory,
} from "@/utils/data-path-migration-cleanup";
import { TestRuntime } from "../helpers/test-runtime";

let runtime: TestRuntime;
let dataRoot: string;
const links: string[] = [];
beforeEach(() => {
  runtime = new TestRuntime("project-migration-cleanup");
  dataRoot = path.join(runtime.root, "old-data-root");
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const link of links.splice(0)) {
    fs.unlinkSync(link);
  }
  expect(runtime.cleanup().status).toBe("deleted");
});

function fixture() {
  const projectId = randomUUID();
  const photoId = randomUUID();
  const directory = path.join(dataRoot, "shooting-projects", projectId);
  fs.mkdirSync(directory, { recursive: true });
  const preview = path.join(directory, `${photoId}.jpg`);
  fs.writeFileSync(preview, "owned preview fixture");
  return {
    directory,
    preview,
    projectId,
    ownership: projectPreviewMigrationOwnership(
      [projectId],
      [{ projectId, id: photoId, previewRelativePath: `${photoId}.jpg` }]
    ),
  };
}

describe("migration cleanup safety", () => {
  it("removes only a verified managed project tree without recursive rm", async () => {
    const { ownership } = fixture();
    const recursiveRemoval = vi.spyOn(fsp, "rm");
    await removeMigratedDataDirectory(dataRoot, "shooting-projects", ownership);
    expect(fs.existsSync(path.join(dataRoot, "shooting-projects"))).toBe(false);
    expect(recursiveRemoval).not.toHaveBeenCalled();
  });

  it("retains an entire project tree when it contains an unregistered UUID image", async () => {
    const { directory, ownership, preview } = fixture();
    const foreign = path.join(directory, `${randomUUID()}.jpg`);
    fs.writeFileSync(foreign, "foreign user content");
    const unlink = vi.spyOn(fsp, "unlink");
    await expect(
      removeMigratedDataDirectory(dataRoot, "shooting-projects", ownership)
    ).rejects.toThrow("CLEANUP_FOREIGN_PROJECT_CONTENT");
    expect(unlink).not.toHaveBeenCalled();
    expect(fs.existsSync(preview)).toBe(true);
    expect(fs.readFileSync(foreign, "utf8")).toBe("foreign user content");
  });

  it.each([
    "protected.csv",
    "protected.xlsx",
    "Temp",
  ])("refuses %s before deleting anything without creating protected test data", async (name) => {
    const { ownership, preview } = fixture();
    // Simulate protected names only. Test cleanup must never delete real CSV,
    // XLSX or Temp content, including files created by a test itself.
    vi.spyOn(fsp, "readdir").mockResolvedValueOnce([name] as never);
    const unlink = vi.spyOn(fsp, "unlink");
    await expect(
      removeMigratedDataDirectory(dataRoot, "shooting-projects", ownership)
    ).rejects.toThrow("CLEANUP_PROTECTED");
    expect(unlink).not.toHaveBeenCalled();
    expect(fs.existsSync(preview)).toBe(true);
    expect(fs.existsSync(path.join(dataRoot, "shooting-projects", name))).toBe(
      false
    );
  });

  it("rejects directory traversal and protected ancestry", async () => {
    await expect(
      removeMigratedDataDirectory(dataRoot, "../outside", new Map())
    ).rejects.toThrow("CLEANUP_INVALID_DIRECTORY");
    await expect(
      removeMigratedDataDirectory(
        path.join(runtime.root, "Temp", "profile"),
        "shooting-projects",
        new Map()
      )
    ).rejects.toThrow("CLEANUP_PROTECTED_TEMP");
    expect(fs.existsSync(path.join(runtime.root, "Temp"))).toBe(false);
  });

  it("refuses linked project directories without touching their target", async () => {
    const projectId = randomUUID();
    const photoId = randomUUID();
    const foreign = path.join(runtime.root, "foreign");
    fs.mkdirSync(foreign);
    const externalPhoto = path.join(foreign, `${photoId}.jpg`);
    fs.writeFileSync(externalPhoto, "external user content");
    fs.mkdirSync(path.join(dataRoot, "shooting-projects"), { recursive: true });
    const link = path.join(dataRoot, "shooting-projects", projectId);
    fs.symlinkSync(
      foreign,
      link,
      process.platform === "win32" ? "junction" : "dir"
    );
    links.push(link);
    const ownership = projectPreviewMigrationOwnership(
      [projectId],
      [{ projectId, id: photoId, previewRelativePath: `${photoId}.jpg` }]
    );
    await expect(
      removeMigratedDataDirectory(dataRoot, "shooting-projects", ownership)
    ).rejects.toThrow("CLEANUP_DIRECTORY_LINK");
    expect(fs.readFileSync(externalPhoto, "utf8")).toBe(
      "external user content"
    );
  });

  it("preserves files introduced after inspection rather than recursively removing them", async () => {
    const { directory, ownership } = fixture();
    const foreign = path.join(directory, "added-after-inspection.txt");
    const actualUnlink = fsp.unlink.bind(fsp);
    vi.spyOn(fsp, "unlink").mockImplementationOnce(async (filename) => {
      await fsp.writeFile(foreign, "new user content");
      await actualUnlink(filename);
    });
    await expect(
      removeMigratedDataDirectory(dataRoot, "shooting-projects", ownership)
    ).rejects.toMatchObject({ code: "ENOTEMPTY" });
    expect(fs.readFileSync(foreign, "utf8")).toBe("new user content");
  });
});
