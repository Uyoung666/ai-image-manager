/** @vitest-environment node */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { closeDatabase, getDatabase } from "@/db";
import {
  cullSessionPhotos,
  cullSessions,
  photos,
  shootingProjectOutputs,
  shootingProjectPhotos,
  shootingProjects,
} from "@/db/schema";
import { clearArchivedTasks } from "@/ipc/cull/handlers";
import { clearArchivedCullTasks } from "@/services/cull-task-archive";
import { projectPreviewDirectory } from "@/services/shooting-project-files";
import { TestRuntime } from "../helpers/test-runtime";

const state = vi.hoisted(() => ({
  dataPath: "",
  stopLibrary: vi.fn(),
  stopOutput: vi.fn(),
}));
vi.mock("@/utils/data-path", () => ({ getDataPath: () => state.dataPath }));
vi.mock("@/services/shooting-project-library", () => ({
  stopShootingProjectLibraryTasks: state.stopLibrary,
}));
vi.mock("@/services/shooting-project-output", () => ({
  stopShootingProjectOutputTasks: state.stopOutput,
}));
let runtime: TestRuntime;
beforeEach(() => {
  vi.clearAllMocks();
  runtime = new TestRuntime("cull-clear-archives");
  state.dataPath = path.join(runtime.root, "profile");
  vi.stubEnv("APPDATA", runtime.root);
});
afterEach(() => {
  closeDatabase();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  expect(runtime.cleanup().status).toBe("deleted");
});

function seedProject(archivedAt: number | null = 10) {
  const db = getDatabase();
  const id = randomUUID();
  const photoId = randomUUID();
  const source = path.join(runtime.root, `${id}.jpg`);
  const copied = path.join(runtime.root, `copied-${id}.jpg`);
  fs.writeFileSync(source, "original bytes");
  fs.writeFileSync(copied, "copied bytes");
  db.insert(shootingProjects)
    .values({
      id,
      sourceRoot: runtime.root,
      name: "shoot",
      archivedAt,
      sourceStatus: "online",
      sourceCheckedAt: 1,
      createdAt: 1,
      updatedAt: 1,
      lastOpenedAt: 1,
    })
    .run();
  db.insert(shootingProjectPhotos)
    .values({
      id: photoId,
      projectId: id,
      filename: path.basename(source),
      relativePath: path.basename(source),
      format: "jpg",
      fileSize: 14,
      modifiedAt: 1,
      createdAt: 1,
      previewRelativePath: `${photoId}.jpg`,
      previewStatus: "ready",
    })
    .run();
  const directory = projectPreviewDirectory(id);
  fs.mkdirSync(directory, { recursive: true });
  const preview = path.join(directory, `${photoId}.jpg`);
  fs.writeFileSync(preview, "preview bytes");
  db.insert(shootingProjectOutputs)
    .values({
      id: randomUUID(),
      projectId: id,
      targetRoot: runtime.root,
      status: "completed",
      createdAt: 1,
    })
    .run();
  const session = db
    .insert(cullSessions)
    .values({
      name: "project round",
      projectId: id,
      mode: "duel",
      archivedAt: 10,
    })
    .returning()
    .get();
  db.insert(cullSessionPhotos)
    .values({ sessionId: session.id, projectPhotoId: photoId })
    .run();
  return { id, source, copied, preview, sessionId: session.id };
}

it("clears both archived task types and owned previews while preserving active tasks and all originals", async () => {
  const archived = seedProject();
  const active = seedProject(null);
  const db = getDatabase();
  const libraryPhoto = db
    .insert(photos)
    .values({ path: archived.source, filename: "original.jpg" })
    .returning()
    .get();
  const library = db
    .insert(cullSessions)
    .values({ name: "archived library", mode: "curate", archivedAt: 10 })
    .returning()
    .get();
  db.insert(cullSessionPhotos)
    .values({ sessionId: library.id, photoId: libraryPhoto.id })
    .run();
  const result = await call(clearArchivedTasks, {
    confirmed: true,
    tasks: [
      { kind: "project", id: archived.id, archivedAt: 10 },
      { kind: "library", id: library.id, archivedAt: 10 },
      { kind: "project", id: active.id, archivedAt: 10 },
      { kind: "library", id: active.sessionId, archivedAt: 10 },
    ],
  });
  expect(result).toEqual({ deleted: 2, failed: 0, skipped: 2 });
  expect(
    db
      .select()
      .from(shootingProjects)
      .all()
      .map((row) => row.id)
  ).toEqual([active.id]);
  expect(
    db
      .select()
      .from(cullSessions)
      .all()
      .map((row) => row.id)
  ).toEqual([active.sessionId]);
  expect(db.select().from(photos).all()).toHaveLength(1);
  expect(db.select().from(shootingProjectOutputs).all()).toHaveLength(1);
  expect(fs.readFileSync(archived.source, "utf8")).toBe("original bytes");
  expect(fs.readFileSync(archived.copied, "utf8")).toBe("copied bytes");
  expect(fs.existsSync(archived.preview)).toBe(false);
  expect(fs.existsSync(active.preview)).toBe(true);
  expect(state.stopLibrary).toHaveBeenCalledWith(archived.id);
  expect(state.stopOutput).toHaveBeenCalledWith(archived.id);
});

it("skips a task restored while background operations are stopping and ignores stale archive snapshots", async () => {
  const project = seedProject();
  state.stopLibrary.mockImplementationOnce(() => {
    getDatabase()
      .update(shootingProjects)
      .set({ archivedAt: null })
      .where(eq(shootingProjects.id, project.id))
      .run();
  });
  expect(
    await clearArchivedCullTasks([
      { kind: "project", id: project.id, archivedAt: 10 },
    ])
  ).toEqual({ deleted: 0, failed: 0, skipped: 1 });
  expect(fs.existsSync(project.preview)).toBe(true);
  expect(
    await clearArchivedCullTasks([
      { kind: "project", id: project.id, archivedAt: 11 },
    ])
  ).toEqual({ deleted: 0, failed: 0, skipped: 1 });
});

it("retains failed tasks and retries them without repeating successful deletions", async () => {
  const project = seedProject();
  state.stopOutput.mockRejectedValueOnce(new Error("busy"));
  const snapshot = [
    { kind: "project" as const, id: project.id, archivedAt: 10 },
  ];
  expect(await clearArchivedCullTasks(snapshot)).toEqual({
    deleted: 0,
    failed: 1,
    skipped: 0,
  });
  expect(fs.existsSync(project.preview)).toBe(true);
  expect(await clearArchivedCullTasks([...snapshot, ...snapshot])).toEqual({
    deleted: 1,
    failed: 0,
    skipped: 0,
  });
});

it("requires confirmation and valid snapshot IDs at the IPC boundary", async () => {
  for (const input of [
    { confirmed: false, tasks: [] },
    {
      confirmed: true,
      tasks: [{ kind: "project", id: "../../", archivedAt: 10 }],
    },
  ]) {
    await expect(
      call(clearArchivedTasks, input as never)
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  }
  expect(state.stopLibrary).not.toHaveBeenCalled();
});
