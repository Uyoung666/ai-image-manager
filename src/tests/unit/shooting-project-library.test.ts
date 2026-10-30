/** @vitest-environment node */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, getDatabase } from "@/db";
import { shootingProjectPhotos } from "@/db/schema";
import { getLightweightFingerprint } from "@/services/shooting-project-files";
import {
  addShootingProjectToLibrary,
  inspectShootingProjectLibrary,
  startShootingProjectLibraryServices,
  stopShootingProjectLibraryTasks,
} from "@/services/shooting-project-library";
import { createShootingProject } from "@/services/shooting-projects";
import { TestRuntime } from "../helpers/test-runtime";

const state = vi.hoisted(() => ({
  dataPath: "",
  index: vi.fn(),
  embed: vi.fn(),
  output: vi.fn(),
}));
vi.mock("@/utils/data-path", () => ({ getDataPath: () => state.dataPath }));
vi.mock("@/services/indexer", () => ({
  indexExplicitPhotoFiles: state.index,
  scanFolder: () => {
    throw new Error("Parent scan is forbidden");
  },
}));
vi.mock("@/services/import-queue", () => ({
  requestExplicitFileEmbedding: state.embed,
}));
vi.mock("@/services/shooting-project-output", () => ({
  resolveShootingProjectCompletedOutputFiles: state.output,
}));
vi.mock("@/ipc/photos/handlers/listing", () => ({
  invalidateCountCache: vi.fn(),
}));
vi.mock("@/ipc/photos/handlers/stats", () => ({
  invalidateStatsCache: vi.fn(),
  invalidateIndexStatsCache: vi.fn(),
}));

let runtime: TestRuntime;
let projectId: string;
let source: string;
async function seedPhoto(name: string, status: "kept" | "pending" = "kept") {
  const id = randomUUID();
  const file = path.join(source, name);
  await fs.writeFile(file, `photo-${name}`);
  const stat = await fs.stat(file);
  getDatabase()
    .insert(shootingProjectPhotos)
    .values({
      id,
      projectId,
      filename: name,
      relativePath: name,
      format: "jpg",
      fileSize: stat.size,
      modifiedAt: stat.mtimeMs,
      createdAt: 1,
      status,
      sourceStatus: "available",
      lightweightFingerprint: await getLightweightFingerprint(file),
    })
    .run();
  return { id, file };
}

beforeEach(async () => {
  vi.clearAllMocks();
  runtime = new TestRuntime("shooting-library");
  state.dataPath = path.join(runtime.root, "profile");
  source = path.join(runtime.root, "source");
  await fs.mkdir(source);
  projectId = (await createShootingProject({ sourceRoot: source })).id;
  state.index.mockResolvedValue({ added: 1, failed: 0, photoIds: [1] });
  startShootingProjectLibraryServices();
});
afterEach(async () => {
  await stopShootingProjectLibraryTasks();
  closeDatabase();
  expect(runtime.cleanup().status).toBe("deleted");
});

describe("explicit shooting project library handoff", () => {
  it("imports only the confirmed receipt and never scans a parent or widens to newly kept photos", async () => {
    const first = await seedPhoto("one.jpg");
    const second = await seedPhoto("two.jpg", "pending");
    const input = { projectId, source: "original" as const };
    const inspected = await inspectShootingProjectLibrary(input);
    expect(inspected.paths).toEqual([first.file]);
    expect(state.index).not.toHaveBeenCalled();
    expect(state.embed).not.toHaveBeenCalled();
    getDatabase()
      .update(shootingProjectPhotos)
      .set({ status: "kept" })
      .where(eq(shootingProjectPhotos.id, second.id))
      .run();
    expect(
      await addShootingProjectToLibrary({
        ...input,
        confirmed: true,
        inspectionToken: inspected.token,
      })
    ).toEqual({ added: 1, failed: 0 });
    expect(state.index).toHaveBeenCalledWith(
      [first.file],
      expect.any(AbortSignal),
      source
    );
    expect(state.embed).toHaveBeenCalledTimes(1);
    await expect(
      addShootingProjectToLibrary({
        ...input,
        confirmed: true,
        inspectionToken: inspected.token,
      })
    ).rejects.toMatchObject({ code: "LIBRARY_INSPECTION_EXPIRED" });
  });

  it("rejects a source changed after confirmation even when its path still exists", async () => {
    const photo = await seedPhoto("one.jpg");
    const input = { projectId, source: "original" as const };
    const inspected = await inspectShootingProjectLibrary(input);
    await fs.writeFile(photo.file, "changed!!");
    await expect(
      addShootingProjectToLibrary({
        ...input,
        confirmed: true,
        inspectionToken: inspected.token,
      })
    ).rejects.toMatchObject({ code: "LIBRARY_SCOPE_CHANGED" });
    expect(state.index).not.toHaveBeenCalled();
  });

  it("preserves unavailable or unverified originals without importing them", async () => {
    const photo = await seedPhoto("one.jpg");
    getDatabase()
      .update(shootingProjectPhotos)
      .set({ sourceStatus: "unverified" })
      .where(eq(shootingProjectPhotos.id, photo.id))
      .run();
    const input = { projectId, source: "original" as const };
    const inspected = await inspectShootingProjectLibrary(input);
    expect(inspected).toMatchObject({ count: 0, unavailable: 1, paths: [] });
    await expect(
      addShootingProjectToLibrary({
        ...input,
        confirmed: true,
        inspectionToken: inspected.token,
      })
    ).rejects.toMatchObject({ code: "LIBRARY_EMPTY" });
    expect(state.index).not.toHaveBeenCalled();
    expect(getDatabase().select().from(shootingProjectPhotos).get()?.id).toBe(
      photo.id
    );
  });

  it("accepts only the verified completed output files from the pinned task", async () => {
    const photo = await seedPhoto("one.jpg");
    const outputPath = path.join(runtime.root, "exported.jpg");
    state.output.mockResolvedValue([{ photoId: photo.id, path: outputPath }]);
    const input = {
      projectId,
      source: "output" as const,
      taskId: randomUUID(),
    };
    const inspected = await inspectShootingProjectLibrary(input);
    expect(inspected.paths).toEqual([outputPath]);
    await addShootingProjectToLibrary({
      ...input,
      confirmed: true,
      inspectionToken: inspected.token,
    });
    expect(state.output).toHaveBeenLastCalledWith({
      projectId,
      taskId: input.taskId,
    });
    expect(state.index).toHaveBeenCalledWith(
      [outputPath],
      expect.any(AbortSignal),
      undefined
    );
  });

  it("invalidates pending receipts when the project or application is stopped", async () => {
    await seedPhoto("one.jpg");
    const input = { projectId, source: "original" as const };
    const inspected = await inspectShootingProjectLibrary(input);
    await stopShootingProjectLibraryTasks(projectId);
    await expect(
      addShootingProjectToLibrary({
        ...input,
        confirmed: true,
        inspectionToken: inspected.token,
      })
    ).rejects.toMatchObject({ code: "LIBRARY_INSPECTION_EXPIRED" });
  });

  it("refuses late inspection and confirmation after a project stops", async () => {
    const photo = await seedPhoto("one.jpg");
    const input = {
      projectId,
      source: "output" as const,
      taskId: randomUUID(),
    };
    let finish:
      | ((files: { photoId: string; path: string }[]) => void)
      | undefined;
    state.output.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const inspecting = inspectShootingProjectLibrary(input);
    await stopShootingProjectLibraryTasks(projectId);
    finish?.([{ photoId: photo.id, path: photo.file }]);
    await expect(inspecting).rejects.toMatchObject({
      code: "LIBRARY_SCOPE_CHANGED",
    });

    state.output.mockResolvedValue([{ photoId: photo.id, path: photo.file }]);
    const inspected = await inspectShootingProjectLibrary(input);
    state.output.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const importing = addShootingProjectToLibrary({
      ...input,
      confirmed: true,
      inspectionToken: inspected.token,
    });
    await stopShootingProjectLibraryTasks(projectId);
    finish?.([{ photoId: photo.id, path: photo.file }]);
    await expect(importing).rejects.toMatchObject({
      code: "LIBRARY_SCOPE_CHANGED",
    });
    expect(state.index).not.toHaveBeenCalled();
    expect(state.embed).not.toHaveBeenCalled();
  });
});
