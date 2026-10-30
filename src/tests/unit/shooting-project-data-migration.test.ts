/** @vitest-environment node */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { call } from "@orpc/server";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase } from "@/db";
import { setDataPath } from "@/ipc/settings/handlers";
import {
  createShootingProject,
  getShootingProjectWorkspace,
  resolveShootingProjectPreview,
  setShootingProjectSelection,
  startShootingProjectServices,
  stopShootingProjectServices,
} from "@/services/shooting-projects";
import { TestRuntime } from "../helpers/test-runtime";

const state = vi.hoisted(() => ({
  dataPath: "",
  root: "",
  stop: vi.fn(),
  start: vi.fn(),
  setPath: vi.fn(),
}));
vi.mock("@/utils/data-path", () => ({
  getDataPath: () => state.dataPath,
  isDefaultDataPath: () => false,
  setCustomDataPath: (value: string) => {
    state.dataPath = value;
    state.setPath(value);
  },
}));
vi.mock("@/services/registry", () => ({
  registry: { stop: state.stop, start: state.start },
}));
vi.mock("electron", () => ({
  app: {
    getAppPath: () => process.cwd(),
    getPath: () => state.root,
    isPackaged: false,
  },
  BrowserWindow: { getAllWindows: () => [] },
}));

let runtime: TestRuntime;
let oldPath: string;
let newPath: string;
let originalPath: string;

beforeEach(() => {
  vi.clearAllMocks();
  runtime = new TestRuntime("shooting-project-migration");
  state.root = runtime.root;
  oldPath = path.join(runtime.root, "old-profile");
  newPath = path.join(runtime.root, "new-profile");
  originalPath = path.join(runtime.root, "source", "original.jpg");
  state.dataPath = oldPath;
  vi.stubEnv("APPDATA", runtime.root);
  state.stop.mockImplementation(async () => {
    await stopShootingProjectServices();
    closeDatabase();
  });
  state.start.mockImplementation(() => {
    startShootingProjectServices();
  });
  startShootingProjectServices();
});

afterEach(async () => {
  await stopShootingProjectServices();
  closeDatabase();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  expect(runtime.cleanup().status).toBe("deleted");
});

async function projectFixture() {
  fs.mkdirSync(path.dirname(originalPath), { recursive: true });
  const buffer = await sharp({
    create: { width: 192, height: 128, channels: 3, background: "#a45823" },
  })
    .jpeg()
    .toBuffer();
  fs.writeFileSync(originalPath, buffer);
  const project = await createShootingProject({
    sourceRoot: path.dirname(originalPath),
  });
  let workspace = await getShootingProjectWorkspace(project.id);
  await vi.waitFor(async () => {
    workspace = await getShootingProjectWorkspace(project.id);
    expect(workspace.project.previewReadyCount).toBe(1);
  });
  const photoId = workspace.photos[0].id;
  await setShootingProjectSelection({
    projectId: project.id,
    photoIds: [photoId],
    status: "kept",
  });
  const preview = await resolveShootingProjectPreview(project.id, photoId);
  if (!preview) {
    throw new Error("Expected cached preview before migration");
  }
  return {
    projectId: project.id,
    photoId,
    preview,
    bytes: fs.readFileSync(preview),
  };
}

describe("shooting project data path migration", () => {
  it("moves the real database and independent previews and reads them at the new data path", async () => {
    const fixture = await projectFixture();
    const original = fs.readFileSync(originalPath);
    const result = await call(setDataPath, { newPath });
    expect(result).toMatchObject({ ok: true, copied: 2, cleaned: 2 });
    const workspace = await getShootingProjectWorkspace(fixture.projectId);
    expect(workspace.project.id).toBe(fixture.projectId);
    expect(workspace.photos[0]).toMatchObject({
      id: fixture.photoId,
      status: "kept",
      previewStatus: "ready",
    });
    const preview = await resolveShootingProjectPreview(
      fixture.projectId,
      fixture.photoId
    );
    expect(preview?.startsWith(path.join(newPath, "shooting-projects"))).toBe(
      true
    );
    if (!preview) {
      throw new Error("Expected migrated preview");
    }
    expect(fs.readFileSync(preview)).toEqual(fixture.bytes);
    expect(fs.readFileSync(originalPath)).toEqual(original);
    expect(fs.existsSync(path.join(oldPath, "data"))).toBe(false);
    expect(fs.existsSync(path.join(oldPath, "shooting-projects"))).toBe(false);
    expect(state.stop).toHaveBeenCalledOnce();
    expect(state.start).toHaveBeenCalledOnce();
  });

  it("keeps foreign old project content and reports retained cleanup while the migrated project remains usable", async () => {
    const fixture = await projectFixture();
    const foreign = path.join(
      oldPath,
      "shooting-projects",
      fixture.projectId,
      "foreign.txt"
    );
    fs.writeFileSync(foreign, "user-owned sidecar");
    const result = await call(setDataPath, { newPath });
    expect(result).toMatchObject({ ok: true, copied: 2, cleaned: 1 });
    expect(result.cleanupErrors?.join(" ")).toContain(
      "CLEANUP_FOREIGN_PROJECT_CONTENT"
    );
    expect(fs.readFileSync(foreign, "utf8")).toBe("user-owned sidecar");
    expect(
      fs.readFileSync(
        path.join(
          newPath,
          "shooting-projects",
          fixture.projectId,
          "foreign.txt"
        ),
        "utf8"
      )
    ).toBe("user-owned sidecar");
    expect(
      await resolveShootingProjectPreview(fixture.projectId, fixture.photoId)
    ).not.toBeNull();
  });

  it("rolls back only newly copied managed data after copy failure and restarts the original project", async () => {
    const fixture = await projectFixture();
    const originalCopy = fsp.cp.bind(fsp);
    vi.spyOn(fsp, "cp").mockImplementation(async (source, target, options) => {
      await originalCopy(source, target, options);
      if (String(source) === path.join(oldPath, "shooting-projects")) {
        throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      }
    });
    const result = await call(setDataPath, { newPath });
    expect(result).toMatchObject({ ok: false });
    expect(state.dataPath).toBe(oldPath);
    expect(fs.existsSync(path.join(newPath, "shooting-projects"))).toBe(false);
    expect(fs.existsSync(path.join(newPath, "data"))).toBe(false);
    expect(
      (await getShootingProjectWorkspace(fixture.projectId)).counts.kept
    ).toBe(1);
    expect(fs.readFileSync(fixture.preview)).toEqual(fixture.bytes);
    expect(state.setPath).not.toHaveBeenCalled();
  });
});
