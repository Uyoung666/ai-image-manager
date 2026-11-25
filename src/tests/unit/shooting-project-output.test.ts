/** @vitest-environment node */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// biome-ignore lint/performance/noNamespaceImport: These tests spy on the real database export to detect access after shutdown.
import * as database from "@/db";
import { closeDatabase, getDatabase } from "@/db";
import {
  folders,
  photos,
  shootingProjectOutputItems,
  shootingProjectOutputs,
  shootingProjectPhotos,
  shootingProjects,
} from "@/db/schema";
import { getLightweightFingerprint } from "@/services/shooting-project-files";
import {
  cancelShootingProjectOutput,
  createShootingProjectOutput as createInspectedOutput,
  inspectShootingProjectOutput,
  listShootingProjectOutputs,
  resolveShootingProjectCompletedOutputFiles,
  retryShootingProjectOutput,
  startShootingProjectOutputServices,
  stopShootingProjectOutputTasks,
} from "@/services/shooting-project-output";
import type { ShootingProjectOutputTask } from "@/types/shooting-project";
import { TestRuntime } from "../helpers/test-runtime";

const state = vi.hoisted(() => ({ dataPath: "" }));
vi.mock("@/utils/data-path", () => ({ getDataPath: () => state.dataPath }));
vi.mock("@/services/import-queue", () => {
  throw new Error("Project output must not enqueue library imports");
});
vi.mock("@/services/ai-embedder", () => {
  throw new Error("Project output must not load AI services");
});

let runtime: TestRuntime;
let projectId: string;
let sourceRoot: string;
let targetParent: string;

beforeEach(() => {
  runtime = new TestRuntime("shooting-project-output");
  state.dataPath = path.join(runtime.root, "profile");
  sourceRoot = path.join(runtime.root, "source");
  targetParent = path.join(runtime.root, "destination");
  fs.mkdirSync(sourceRoot, { recursive: true });
  fs.mkdirSync(targetParent, { recursive: true });
  projectId = randomUUID();
  vi.stubEnv("APPDATA", runtime.root);
  getDatabase()
    .insert(shootingProjects)
    .values({
      id: projectId,
      name: "秋日拍摄",
      sourceRoot,
      sourceStatus: "online",
      sourceCheckedAt: 1,
      createdAt: 1,
      updatedAt: 1,
      lastOpenedAt: 1,
    })
    .run();
  startShootingProjectOutputServices();
});

afterEach(async () => {
  await stopShootingProjectOutputTasks();
  vi.restoreAllMocks();
  closeDatabase();
  vi.unstubAllEnvs();
  expect(runtime.cleanup().status).toBe("deleted");
});

async function addPhoto(
  relativePath = "day-one/photo.jpg",
  bytes = Buffer.from("Original bytes remain unchanged")
) {
  const sourcePath = path.join(sourceRoot, relativePath);
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(sourcePath, bytes);
  const stat = fs.statSync(sourcePath);
  const id = randomUUID();
  const row = {
    id,
    projectId,
    relativePath,
    filename: path.basename(relativePath),
    fileSize: stat.size,
    modifiedAt: stat.mtimeMs,
    format: path.extname(relativePath).slice(1),
    status: "kept" as const,
    sourceStatus: "available" as const,
    lightweightFingerprint: await getLightweightFingerprint(sourcePath),
    createdAt: 1,
  };
  getDatabase().insert(shootingProjectPhotos).values(row).run();
  return { ...row, sourcePath, bytes };
}

async function createShootingProjectOutput(
  input: Omit<
    Parameters<typeof createInspectedOutput>[0],
    "inspectionToken" | "decisions"
  >
) {
  const { token } = await inspectShootingProjectOutput(input);
  return await createInspectedOutput({
    ...input,
    inspectionToken: token,
    decisions: [],
  });
}

async function settled(taskId: string): Promise<ShootingProjectOutputTask> {
  let result: ShootingProjectOutputTask | undefined;
  await vi.waitFor(
    async () => {
      result = (await listShootingProjectOutputs(projectId)).find(
        (task) => task.id === taskId
      );
      expect(result).toBeDefined();
      expect(["pending", "running"]).not.toContain(result?.status);
    },
    { timeout: 10_000, interval: 10 }
  );
  if (!result) {
    throw new Error("Output did not settle");
  }
  return result;
}

function digest(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function recoveredTask(
  photo: Awaited<ReturnType<typeof addPhoto>>,
  stage: "copying" | "verifying" | "committing",
  finalFile: boolean
) {
  const taskId = randomUUID();
  const itemId = randomUUID();
  const targetRoot = path.join(targetParent, "Recovered");
  const targetPath = path.join(targetRoot, photo.relativePath);
  const tempPath = path.join(
    targetRoot,
    `.aim-output-${taskId}-${itemId}.partial`
  );
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(
    tempPath,
    stage === "copying" ? photo.bytes.subarray(0, 4) : photo.bytes
  );
  if (finalFile) {
    fs.copyFileSync(tempPath, targetPath);
  }
  getDatabase()
    .insert(shootingProjectOutputs)
    .values({
      id: taskId,
      projectId,
      targetRoot,
      status: "running",
      createdAt: 1,
    })
    .run();
  getDatabase()
    .insert(shootingProjectOutputItems)
    .values({
      id: itemId,
      taskId,
      photoId: photo.id,
      kind: "original",
      relativePath: photo.relativePath,
      sourcePath: photo.sourcePath,
      targetPath,
      tempPath,
      fileSize: photo.fileSize,
      modifiedAt: photo.modifiedAt,
      lightweightFingerprint: photo.lightweightFingerprint,
      status: stage,
      sha256: stage === "committing" ? digest(photo.bytes) : null,
      copiedBytes: finalFile ? photo.fileSize : 4,
    })
    .run();
  return { taskId, itemId, targetRoot, targetPath, tempPath };
}

describe("shooting project original output", () => {
  it("copies byte-identical originals, preserves directories, records full hashes and leaves the library untouched", async () => {
    const photo = await addPhoto();
    const db = getDatabase();
    const beforeLibrary = db.select().from(photos).all();
    const beforeFolders = db.select().from(folders).all();
    const inspected = await inspectShootingProjectOutput({
      projectId,
      targetParent,
    });
    expect(inspected).toMatchObject({
      count: 1,
      originalCount: 1,
      xmpCount: 0,
      unavailable: 0,
      bytes: photo.fileSize,
      watched: false,
    });
    expect(fs.existsSync(inspected.targetRoot)).toBe(false);
    const created = await createShootingProjectOutput({
      projectId,
      targetParent,
    });
    const completed = await settled(created.id);
    expect(completed.status).toBe("completed");
    expect(completed.items[0]).toMatchObject({
      status: "completed",
      relativePath: photo.relativePath,
      sha256: digest(photo.bytes),
      copiedBytes: photo.fileSize,
    });
    expect(fs.readFileSync(completed.items[0].targetPath)).toEqual(photo.bytes);
    expect(fs.readFileSync(photo.sourcePath)).toEqual(photo.bytes);
    expect(db.select().from(photos).all()).toEqual(beforeLibrary);
    expect(db.select().from(folders).all()).toEqual(beforeFolders);
    expect(
      db
        .select()
        .from(shootingProjectPhotos)
        .where(eq(shootingProjectPhotos.id, photo.id))
        .get()?.contentHash
    ).toBe(digest(photo.bytes));
    expect(
      await resolveShootingProjectCompletedOutputFiles({
        projectId,
        taskId: created.id,
      })
    ).toEqual([{ photoId: photo.id, path: completed.items[0].targetPath }]);
    expect(fs.readdirSync(path.dirname(completed.items[0].targetPath))).toEqual(
      [photo.filename]
    );
  });

  it("copies an explicitly selected pending photo and fixes selection and source paths in the manifest", async () => {
    const first = await addPhoto();
    const second = await addPhoto(
      "day-two/other.jpg",
      Buffer.from("second image")
    );
    getDatabase()
      .update(shootingProjectPhotos)
      .set({ status: "pending" })
      .where(eq(shootingProjectPhotos.id, second.id))
      .run();
    const task = await createShootingProjectOutput({
      projectId,
      targetParent,
      photoIds: [second.id],
    });
    getDatabase()
      .update(shootingProjectPhotos)
      .set({ status: "kept" })
      .where(eq(shootingProjectPhotos.id, first.id))
      .run();
    getDatabase()
      .update(shootingProjects)
      .set({ sourceRoot: path.join(runtime.root, "new-root") })
      .where(eq(shootingProjects.id, projectId))
      .run();
    const completed = await settled(task.id);
    expect(completed.status).toBe("completed");
    expect(completed.items.map((item) => item.photoId)).toEqual([second.id]);
    expect(completed.items[0].sourcePath).toBe(second.sourcePath);
    expect(
      fs.existsSync(path.join(completed.targetRoot, first.relativePath))
    ).toBe(false);
    expect(
      getDatabase()
        .select()
        .from(shootingProjectPhotos)
        .where(eq(shootingProjectPhotos.id, second.id))
        .get()?.contentHash
    ).toBeNull();
  });

  it("creates a separate output directory on every new output and never overwrites an existing directory", async () => {
    await addPhoto();
    const existing = path.join(targetParent, "秋日拍摄");
    fs.mkdirSync(existing);
    fs.writeFileSync(path.join(existing, "user.txt"), "keep me");
    const first = await createShootingProjectOutput({
      projectId,
      targetParent,
    });
    await settled(first.id);
    const second = await createShootingProjectOutput({
      projectId,
      targetParent,
    });
    await settled(second.id);
    expect(path.basename(first.targetRoot)).toBe("秋日拍摄 (2)");
    expect(path.basename(second.targetRoot)).toBe("秋日拍摄 (3)");
    expect(fs.readFileSync(path.join(existing, "user.txt"), "utf8")).toBe(
      "keep me"
    );
  });

  it("copies same-directory same-stem XMP once for separately selected RAW and JPEG", async () => {
    const raw = await addPhoto(
      "images/IMG_0001.cr2",
      Buffer.from("RAW unchanged")
    );
    await addPhoto("images/IMG_0001.jpg", Buffer.from("JPEG unchanged"));
    const sidecar = path.join(sourceRoot, "images", "IMG_0001.XMP");
    fs.writeFileSync(sidecar, "<x:xmpmeta>unchanged sidecar</x:xmpmeta>");
    const inspected = await inspectShootingProjectOutput({
      projectId,
      targetParent,
    });
    expect(inspected.count).toBe(3);
    const created = await createShootingProjectOutput({
      projectId,
      targetParent,
    });
    const task = await settled(created.id);
    expect(task.status).toBe("completed");
    expect(task.items.filter((item) => item.kind === "xmp")).toHaveLength(1);
    const xmp = task.items.find((item) => item.kind === "xmp");
    expect(xmp && fs.readFileSync(xmp.targetPath, "utf8")).toBe(
      fs.readFileSync(sidecar, "utf8")
    );
    expect(fs.readFileSync(raw.sourcePath)).toEqual(raw.bytes);
  });

  it("includes full-name XMP and standalone ACR, and scans each source directory once per pass", async () => {
    const raw = await addPhoto("day-one/IMG.01.NEF");
    const jpeg = await addPhoto("day-one/IMG.01.JPG");
    await addPhoto("day-two/IMG.01.NEF");
    const expected = [
      "day-one/IMG.01.NEF.XMP",
      "day-one/IMG.01.JPG.xmp",
      "day-one/IMG.01.ACR",
      "day-two/IMG.01.xmp",
    ];
    for (const relative of expected) {
      fs.writeFileSync(path.join(sourceRoot, relative), relative);
    }
    fs.writeFileSync(
      path.join(sourceRoot, "day-one", "IMG.01_01.NEF.xmp"),
      "numbered edit"
    );
    const read = vi.spyOn(fsp, "readdir");
    const inspected = await inspectShootingProjectOutput({
      projectId,
      targetParent,
    });
    expect(inspected).toMatchObject({
      originalCount: 3,
      xmpCount: 3,
      acrCount: 1,
      count: 7,
      ambiguities: [],
    });
    expect(read).toHaveBeenCalledTimes(2);
    const created = await createInspectedOutput({
      projectId,
      targetParent,
      inspectionToken: inspected.token,
      decisions: [],
    });
    expect(read).toHaveBeenCalledTimes(4);
    const result = await settled(created.id);
    expect(result.status).toBe("completed");
    const sidecars = result.items.filter((item) => item.kind !== "original");
    expect(sidecars.map((item) => item.relativePath).sort()).toEqual(
      expected.map((relative) => path.normalize(relative)).sort()
    );
    for (const item of sidecars) {
      expect(fs.readFileSync(item.targetPath)).toEqual(
        fs.readFileSync(item.sourcePath)
      );
      expect(item.sha256).toBe(digest(fs.readFileSync(item.sourcePath)));
    }
    expect(
      sidecars.find((item) => item.relativePath.endsWith("NEF.XMP"))?.photoId
    ).toBe(raw.id);
    expect(
      sidecars.find((item) => item.relativePath.endsWith("JPG.xmp"))?.photoId
    ).toBe(jpeg.id);
    expect(
      await resolveShootingProjectCompletedOutputFiles({
        projectId,
        taskId: result.id,
      })
    ).toHaveLength(3);
  });

  it.each([
    "include",
    "skip",
  ] as const)("honors the decision to %s shared files beside an unscanned JPEG", async (action) => {
    const raw = await addPhoto("IMG.NEF");
    fs.writeFileSync(path.join(sourceRoot, "IMG.JPG"), "unscanned");
    fs.writeFileSync(path.join(sourceRoot, "IMG.NEF.xmp"), "raw only");
    fs.writeFileSync(path.join(sourceRoot, "IMG.xmp"), "shared XMP");
    fs.writeFileSync(path.join(sourceRoot, "IMG.acr"), "shared ACR");
    const input = { projectId, targetParent, photoIds: [raw.id] };
    const inspection = await inspectShootingProjectOutput(input);
    expect(inspection).toMatchObject({ count: 2, xmpCount: 1, acrCount: 0 });
    expect(inspection.ambiguities).toHaveLength(1);
    const [group] = inspection.ambiguities;
    expect(group.photos).toEqual([
      { relativePath: "IMG.JPG", selected: false },
      { relativePath: "IMG.NEF", selected: true },
    ]);
    expect(group.files.map((item) => item.relativePath)).toEqual([
      "IMG.acr",
      "IMG.xmp",
    ]);
    await expect(
      createInspectedOutput({
        ...input,
        inspectionToken: inspection.token,
        decisions: [],
      })
    ).rejects.toMatchObject({ code: "OUTPUT_INSPECTION_CHANGED" });
    expect(fs.readdirSync(targetParent)).toEqual([]);
    const created = await createInspectedOutput({
      ...input,
      inspectionToken: inspection.token,
      decisions: [{ id: group.id, action }],
    });
    const task = await settled(created.id);
    expect(task.status).toBe("completed");
    expect(fs.readdirSync(task.targetRoot).sort()).toEqual(
      action === "include"
        ? ["IMG.NEF", "IMG.NEF.xmp", "IMG.acr", "IMG.xmp"]
        : ["IMG.NEF", "IMG.NEF.xmp"]
    );
    expect(task.skippedSidecars).toEqual(
      action === "skip" ? ["IMG.acr", "IMG.xmp"] : undefined
    );
  });

  it("reserves a full-name XMP for its original even when another selected filename shares that stem", async () => {
    await addPhoto("IMG.NEF");
    const jpeg = await addPhoto("IMG.NEF.JPG");
    fs.writeFileSync(
      path.join(sourceRoot, "IMG.NEF.xmp"),
      "belongs to IMG.NEF"
    );
    const input = { projectId, targetParent, photoIds: [jpeg.id] };
    expect(await inspectShootingProjectOutput(input)).toMatchObject({
      count: 1,
      xmpCount: 0,
      acrCount: 0,
      ambiguities: [],
    });
  });

  it("keeps registered but missing originals in sidecar ownership checks", async () => {
    const missing = await addPhoto("pair.NEF");
    const jpeg = await addPhoto("pair.JPG");
    const dotted = await addPhoto("pair.NEF.JPG");
    fs.renameSync(missing.sourcePath, path.join(runtime.root, "offline.nef"));
    fs.writeFileSync(
      path.join(sourceRoot, "pair.NEF.xmp"),
      "belongs to missing RAW"
    );
    fs.writeFileSync(path.join(sourceRoot, "pair.xmp"), "shared metadata");

    const inspection = await inspectShootingProjectOutput({
      projectId,
      targetParent,
      photoIds: [jpeg.id, dotted.id],
    });
    expect(inspection.xmpCount).toBe(0);
    expect(inspection.ambiguities).toHaveLength(1);
    expect(inspection.ambiguities[0]).toMatchObject({
      files: [{ relativePath: "pair.xmp" }],
      photos: expect.arrayContaining([
        { relativePath: "pair.NEF", selected: false },
        { relativePath: "pair.JPG", selected: true },
      ]),
    });
  });

  it("lets the user skip a locked optional sidecar without blocking the original", async () => {
    const raw = await addPhoto("pair.NEF");
    await addPhoto("pair.JPG");
    const sidecar = path.join(sourceRoot, "pair.acr");
    fs.writeFileSync(sidecar, "locked edit");
    const open = fsp.open.bind(fsp);
    vi.spyOn(fsp, "open").mockImplementation(async (file, ...args) => {
      if (String(file) === sidecar) {
        throw Object.assign(new Error("File is locked"), { code: "EACCES" });
      }
      return await open(file, ...args);
    });
    const input = { projectId, targetParent, photoIds: [raw.id] };
    const inspection = await inspectShootingProjectOutput(input);
    expect(inspection.ambiguities[0].files).toMatchObject([
      { relativePath: "pair.acr", unavailable: true },
    ]);
    const [{ id }] = inspection.ambiguities;
    await expect(
      createInspectedOutput({
        ...input,
        inspectionToken: inspection.token,
        decisions: [{ id, action: "include" }],
      })
    ).rejects.toMatchObject({ code: "OUTPUT_PERMISSION_DENIED" });
    expect(fs.readdirSync(targetParent)).toEqual([]);
    const created = await createInspectedOutput({
      ...input,
      inspectionToken: inspection.token,
      decisions: [{ id, action: "skip" }],
    });
    const task = await settled(created.id);
    expect(task).toMatchObject({
      status: "completed",
      skippedSidecars: ["pair.acr"],
      items: [{ photoId: raw.id, status: "completed" }],
    });
  });

  it("refreshes when files appear after inspection, and accepts each new preview only once", async () => {
    await addPhoto("IMG.NEF");
    fs.writeFileSync(path.join(sourceRoot, "IMG.xmp"), "shared metadata");
    const input = { projectId, targetParent };
    const before = await inspectShootingProjectOutput(input);
    fs.writeFileSync(path.join(sourceRoot, "IMG.JPG"), "unselected");
    fs.writeFileSync(path.join(sourceRoot, "IMG.acr"), "new edit");
    await expect(
      createInspectedOutput({
        ...input,
        inspectionToken: before.token,
        decisions: [],
      })
    ).rejects.toMatchObject({ code: "OUTPUT_INSPECTION_CHANGED" });
    expect(fs.readdirSync(targetParent)).toEqual([]);
    const after = await inspectShootingProjectOutput(input);
    expect(after.ambiguities[0].files).toHaveLength(2);
    const request = {
      ...input,
      inspectionToken: after.token,
      decisions: [{ id: after.ambiguities[0].id, action: "include" as const }],
    };
    const first = createInspectedOutput(request);
    await expect(createInspectedOutput(request)).rejects.toMatchObject({
      code: "OUTPUT_BUSY",
    });
    const created = await first;
    await expect(createInspectedOutput(request)).rejects.toMatchObject({
      code: "OUTPUT_INSPECTION_EXPIRED",
    });
    expect((await settled(created.id)).items).toHaveLength(3);
    expect(fs.readdirSync(targetParent)).toHaveLength(1);
  });

  it("allows an accepted inspection to finish rechecking after its expiry time", async () => {
    await addPhoto();
    const input = { projectId, targetParent };
    const started = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(started);
    const accepted = await inspectShootingProjectOutput(input);
    const statfs = vi.spyOn(fsp, "statfs").mockImplementation(() => {
      clock.mockReturnValue(started + 11 * 60_000);
      return Promise.resolve({
        bavail: 100n,
        bsize: 4096n,
      } as fs.BigIntStatsFs);
    });
    const created = await createInspectedOutput({
      ...input,
      inspectionToken: accepted.token,
      decisions: [],
    });
    statfs.mockRestore();
    expect((await settled(created.id)).status).toBe("completed");
    const expired = await inspectShootingProjectOutput(input);
    clock.mockReturnValue(started + 22 * 60_000);
    await expect(
      createInspectedOutput({
        ...input,
        inspectionToken: expired.token,
        decisions: [],
      })
    ).rejects.toMatchObject({ code: "OUTPUT_INSPECTION_EXPIRED" });
    expect(await listShootingProjectOutputs(projectId)).toHaveLength(1);
  });

  it("rejects output under the source, protected Temp destinations, empty selections and another project's IDs", async () => {
    await addPhoto();
    await expect(
      createShootingProjectOutput({ projectId, targetParent: sourceRoot })
    ).rejects.toMatchObject({ code: "OUTPUT_TARGET_INSIDE_SOURCE" });
    const protectedRoot = path.join(targetParent, "Temp");
    await expect(
      inspectShootingProjectOutput({ projectId, targetParent: protectedRoot })
    ).rejects.toMatchObject({ code: "OUTPUT_INVALID_TARGET" });
    await expect(
      createShootingProjectOutput({ projectId, targetParent, photoIds: [] })
    ).rejects.toMatchObject({ code: "OUTPUT_EMPTY" });
    await expect(
      createShootingProjectOutput({
        projectId,
        targetParent,
        photoIds: [randomUUID()],
      })
    ).rejects.toMatchObject({ code: "OUTPUT_NOT_FOUND" });
    expect(fs.readdirSync(targetParent)).toEqual([]);
  });

  it("requires current watcher confirmation with directory boundary matching, including on retry", async () => {
    await addPhoto();
    const watcher = getDatabase()
      .insert(folders)
      .values({ path: targetParent, displayName: "watched", isWatching: true })
      .returning()
      .get();
    const prefixSibling = `${targetParent}-other`;
    fs.mkdirSync(prefixSibling);
    expect(
      (
        await inspectShootingProjectOutput({
          projectId,
          targetParent: prefixSibling,
        })
      ).watched
    ).toBe(false);
    expect(
      (await inspectShootingProjectOutput({ projectId, targetParent })).watched
    ).toBe(true);
    await expect(
      createShootingProjectOutput({ projectId, targetParent })
    ).rejects.toMatchObject({ code: "OUTPUT_WATCH_CONFIRMATION_REQUIRED" });
    expect(fs.readdirSync(targetParent)).toEqual([]);
    const created = await createShootingProjectOutput({
      projectId,
      targetParent,
      acknowledgeWatchedTarget: true,
    });
    await settled(created.id);
    await expect(
      retryShootingProjectOutput({ projectId, taskId: created.id })
    ).rejects.toMatchObject({ code: "OUTPUT_WATCH_CONFIRMATION_REQUIRED" });
    getDatabase()
      .update(folders)
      .set({ isWatching: false })
      .where(eq(folders.id, watcher.id))
      .run();
    await retryShootingProjectOutput({ projectId, taskId: created.id });
    expect((await settled(created.id)).status).toBe("completed");
  });

  it("reports insufficient free space before creating a destination directory", async () => {
    await addPhoto();
    vi.spyOn(fsp, "statfs").mockResolvedValue({
      bavail: 0n,
      bsize: 4096n,
    } as fs.BigIntStatsFs);
    await expect(
      createShootingProjectOutput({ projectId, targetParent })
    ).rejects.toMatchObject({ code: "OUTPUT_NO_SPACE" });
    expect(fs.readdirSync(targetParent)).toEqual([]);
    expect(await listShootingProjectOutputs(projectId)).toEqual([]);
  });

  it("copies online items when another selected source directory disappeared", async () => {
    const online = await addPhoto("online/current.nef");
    const offline = await addPhoto("offline/missing.nef");
    const originalDirectory = path.dirname(offline.sourcePath);
    const detachedDirectory = path.join(runtime.root, "detached-source");
    fs.renameSync(originalDirectory, detachedDirectory);

    const input = { projectId, targetParent };
    const inspection = await inspectShootingProjectOutput(input);
    expect(inspection).toMatchObject({ originalCount: 2, unavailable: 1 });
    const created = await createInspectedOutput({
      ...input,
      inspectionToken: inspection.token,
      decisions: [],
    });
    const task = await settled(created.id);
    expect(task.status).toBe("failed");
    expect(
      task.items.find((item) => item.photoId === offline.id)
    ).toMatchObject({
      error: "OUTPUT_SOURCE_UNAVAILABLE",
      status: "failed",
    });
    const copied = task.items.find((item) => item.photoId === online.id);
    expect(copied?.status).toBe("completed");
    expect(fs.readFileSync(copied?.targetPath ?? "")).toEqual(online.bytes);

    fs.renameSync(detachedDirectory, originalDirectory);
    await retryShootingProjectOutput({ projectId, taskId: created.id });
    expect((await settled(created.id)).status).toBe("completed");
  });

  it("rejects a destination junction into the source before creating output files", async () => {
    await addPhoto();
    const inner = path.join(sourceRoot, "output-destination");
    fs.mkdirSync(inner);
    const linked = path.join(runtime.root, "linked-destination");
    fs.symlinkSync(
      inner,
      linked,
      process.platform === "win32" ? "junction" : "dir"
    );
    try {
      await expect(
        createShootingProjectOutput({ projectId, targetParent: linked })
      ).rejects.toMatchObject({ code: "OUTPUT_TARGET_INSIDE_SOURCE" });
      expect(fs.readdirSync(inner)).toEqual([]);
    } finally {
      fs.unlinkSync(linked);
    }
  });

  it("refuses a replaced destination subdirectory junction without writing or deleting its target", async () => {
    const photo = await addPhoto();
    const recovered = recoveredTask(photo, "copying", false);
    const linked = path.dirname(recovered.targetPath);
    fs.rmdirSync(linked);
    const outside = path.join(runtime.root, "outside-output");
    fs.mkdirSync(outside);
    const foreign = path.join(outside, photo.filename);
    fs.writeFileSync(foreign, "user-managed bytes");
    fs.symlinkSync(
      outside,
      linked,
      process.platform === "win32" ? "junction" : "dir"
    );
    try {
      startShootingProjectOutputServices();
      await retryShootingProjectOutput({ projectId, taskId: recovered.taskId });
      const task = await settled(recovered.taskId);
      expect(task.status).toBe("failed");
      expect(task.items[0].error).toBe("OUTPUT_INVALID_TARGET");
      expect(fs.readFileSync(foreign, "utf8")).toBe("user-managed bytes");
    } finally {
      fs.unlinkSync(linked);
    }
  });

  it("keeps an old task pinned to the old source after relinking and allows a fresh task", async () => {
    const photo = await addPhoto();
    const recovered = recoveredTask(photo, "copying", false);
    const newRoot = path.join(runtime.root, "moved-source");
    fs.renameSync(sourceRoot, newRoot);
    getDatabase()
      .update(shootingProjects)
      .set({ sourceRoot: newRoot })
      .where(eq(shootingProjects.id, projectId))
      .run();
    startShootingProjectOutputServices();
    await retryShootingProjectOutput({ projectId, taskId: recovered.taskId });
    const old = await settled(recovered.taskId);
    expect(old.status).toBe("failed");
    expect(old.items[0]).toMatchObject({
      sourcePath: photo.sourcePath,
      error: "OUTPUT_SOURCE_UNAVAILABLE",
    });
    const fresh = await createShootingProjectOutput({
      projectId,
      targetParent,
    });
    expect((await settled(fresh.id)).status).toBe("completed");
  });

  it("does not convert sampled evidence into an accepted original when a photo is unverified", async () => {
    const photo = await addPhoto();
    getDatabase()
      .update(shootingProjectPhotos)
      .set({ sourceStatus: "unverified" })
      .where(eq(shootingProjectPhotos.id, photo.id))
      .run();
    expect(
      (await inspectShootingProjectOutput({ projectId, targetParent }))
        .unavailable
    ).toBe(1);
    const created = await createShootingProjectOutput({
      projectId,
      targetParent,
    });
    const task = await settled(created.id);
    expect(task.status).toBe("failed");
    expect(task.items[0].error).toBe("OUTPUT_UNVERIFIED");
    expect(fs.existsSync(task.items[0].targetPath)).toBe(false);
  });

  it("detects changed source bytes even with preserved size and modification time", async () => {
    const photo = await addPhoto();
    const before = fs.statSync(photo.sourcePath);
    fs.writeFileSync(photo.sourcePath, Buffer.alloc(photo.fileSize, 0x78));
    fs.utimesSync(photo.sourcePath, before.atime, before.mtime);
    const created = await createShootingProjectOutput({
      projectId,
      targetParent,
    });
    const task = await settled(created.id);
    expect(task.status).toBe("failed");
    expect(task.items[0]).toMatchObject({
      status: "failed",
      error: "OUTPUT_SOURCE_CHANGED",
    });
    expect(fs.existsSync(task.items[0].targetPath)).toBe(false);
  });

  it("does not replace a modified completed output when explicitly retried", async () => {
    await addPhoto();
    const created = await createShootingProjectOutput({
      projectId,
      targetParent,
    });
    const task = await settled(created.id);
    const target = task.items[0].targetPath;
    fs.writeFileSync(target, "user retouched original");
    await retryShootingProjectOutput({ projectId, taskId: task.id });
    const retried = await settled(task.id);
    expect(retried.status).toBe("failed");
    expect(retried.items[0].error).toBe("OUTPUT_CONFLICT");
    expect(fs.readFileSync(target, "utf8")).toBe("user retouched original");
  });

  it("uses a historical full hash when metadata and every sampled block still match", async () => {
    const photo = await addPhoto(
      "sample-collision.raw",
      Buffer.alloc(1024 * 1024, 0x11)
    );
    getDatabase()
      .update(shootingProjectPhotos)
      .set({ contentHash: digest(photo.bytes) })
      .where(eq(shootingProjectPhotos.id, photo.id))
      .run();
    const altered = Buffer.from(photo.bytes);
    altered.fill(0xee, 128 * 1024, 129 * 1024);
    fs.writeFileSync(photo.sourcePath, altered);
    const actual = fs.statSync(photo.sourcePath);
    getDatabase()
      .update(shootingProjectPhotos)
      .set({ modifiedAt: actual.mtimeMs })
      .where(eq(shootingProjectPhotos.id, photo.id))
      .run();
    expect(await getLightweightFingerprint(photo.sourcePath)).toBe(
      photo.lightweightFingerprint
    );
    const created = await createShootingProjectOutput({
      projectId,
      targetParent,
    });
    const task = await settled(created.id);
    expect(task.status).toBe("failed");
    expect(task.items[0]).toMatchObject({
      error: "OUTPUT_SOURCE_CHANGED",
      status: "failed",
    });
    expect(fs.existsSync(task.items[0].targetPath)).toBe(false);
  });

  it("reports verification failure for damaged temporary bytes and leaves no successful result", async () => {
    await addPhoto();
    const open = fsp.open.bind(fsp);
    vi.spyOn(fsp, "open").mockImplementation(async (filename, ...args) => {
      const handle = await open(filename, ...args);
      if (String(filename).endsWith(".partial") && args[0] === "wx") {
        const sync = handle.sync.bind(handle);
        handle.sync = async () => {
          await sync();
          await handle.write(Buffer.from("bad"), 0, 3, 0);
        };
      }
      return handle;
    });
    const created = await createShootingProjectOutput({
      projectId,
      targetParent,
    });
    const task = await settled(created.id);
    expect(task.status).toBe("failed");
    expect(task.items[0].error).toBe("OUTPUT_VERIFY_FAILED");
    expect(fs.existsSync(task.items[0].targetPath)).toBe(false);
    expect(fs.readdirSync(path.dirname(task.items[0].targetPath))).toEqual([]);
  });

  it("reports a disk-full write separately and does not commit its temporary file", async () => {
    await addPhoto();
    const open = fsp.open.bind(fsp);
    vi.spyOn(fsp, "open").mockImplementation(async (filename, ...args) => {
      const handle = await open(filename, ...args);
      if (String(filename).endsWith(".partial") && args[0] === "wx") {
        handle.write = (() =>
          Promise.reject(
            Object.assign(new Error("disk full"), { code: "ENOSPC" })
          )) as typeof handle.write;
      }
      return handle;
    });
    const created = await createShootingProjectOutput({
      projectId,
      targetParent,
    });
    const task = await settled(created.id);
    expect(task.status).toBe("failed");
    expect(task.items[0].error).toBe("OUTPUT_NO_SPACE");
    expect(fs.existsSync(task.items[0].targetPath)).toBe(false);
    expect(fs.readdirSync(task.targetRoot)).toEqual(["day-one"]);
  });

  it("falls back to exclusive copy on removable filesystems without hard links", async () => {
    const photo = await addPhoto();
    vi.spyOn(fsp, "link").mockRejectedValue(
      Object.assign(new Error("unsupported"), { code: "EOPNOTSUPP" })
    );
    const created = await createShootingProjectOutput({
      projectId,
      targetParent,
    });
    const task = await settled(created.id);
    expect(task.status).toBe("completed");
    expect(fs.readFileSync(task.items[0].targetPath)).toEqual(photo.bytes);
  });

  it("retains the commit receipt when saving success fails after the final file was committed", async () => {
    const photo = await addPhoto();
    const created = await createShootingProjectOutput({
      projectId,
      targetParent,
    });
    const transaction = vi
      .spyOn(getDatabase(), "transaction")
      .mockImplementationOnce(() => {
        throw new Error("database save failed");
      });
    const failed = await settled(created.id);
    transaction.mockRestore();
    expect(failed.status).toBe("failed");
    expect(failed.items[0]).toMatchObject({
      status: "committing",
      sha256: digest(photo.bytes),
    });
    const before = fs.statSync(failed.items[0].targetPath).mtimeMs;
    getDatabase()
      .update(shootingProjectOutputs)
      .set({ status: "running" })
      .where(eq(shootingProjectOutputs.id, created.id))
      .run();
    closeDatabase();
    startShootingProjectOutputServices();
    await retryShootingProjectOutput({ projectId, taskId: created.id });
    const recovered = await settled(created.id);
    expect(recovered.status).toBe("completed");
    expect(fs.statSync(recovered.items[0].targetPath).mtimeMs).toBe(before);
  });

  it("detects a source modification while copying and does not commit the partial result", async () => {
    const photo = await addPhoto(
      "changing.jpg",
      Buffer.alloc(3 * 1024 * 1024, 0x13)
    );
    const open = fsp.open.bind(fsp);
    let changed = false;
    vi.spyOn(fsp, "open").mockImplementation(async (filename, ...args) => {
      const handle = await open(filename, ...args);
      if (String(filename) === photo.sourcePath && args[0] === "r") {
        const read = handle.read.bind(handle);
        handle.read = (async (
          buffer: Buffer,
          offset: number,
          length: number,
          position: number
        ) => {
          const result = await read(buffer, offset, length, position);
          if (length === 1024 * 1024 && position >= 1024 * 1024 && !changed) {
            changed = true;
            await fsp.appendFile(photo.sourcePath, "external edit");
          }
          return result;
        }) as typeof handle.read;
      }
      return handle;
    });
    const created = await createShootingProjectOutput({
      projectId,
      targetParent,
    });
    const task = await settled(created.id);
    expect(task.status).toBe("failed");
    expect(task.items[0].error).toBe("OUTPUT_SOURCE_CHANGED");
    expect(fs.existsSync(task.items[0].targetPath)).toBe(false);
  });

  it("keeps an unrecorded same-name conflict even when it happens to have the expected bytes", async () => {
    const photo = await addPhoto();
    const recovered = await recoveredTask(photo, "copying", false);
    fs.writeFileSync(recovered.targetPath, photo.bytes);
    startShootingProjectOutputServices();
    await retryShootingProjectOutput({ projectId, taskId: recovered.taskId });
    const task = await settled(recovered.taskId);
    expect(task.status).toBe("failed");
    expect(task.items[0].error).toBe("OUTPUT_CONFLICT");
    expect(fs.readFileSync(recovered.targetPath)).toEqual(photo.bytes);
  });

  for (const stage of ["copying", "verifying", "committing"] as const) {
    it(`retains an interrupted ${stage} task and resumes its fixed manifest only on explicit retry`, async () => {
      const photo = await addPhoto();
      const recovered = await recoveredTask(photo, stage, false);
      closeDatabase();
      startShootingProjectOutputServices();
      const [interrupted] = await listShootingProjectOutputs(projectId);
      expect(interrupted.status).toBe("interrupted");
      expect(fs.existsSync(recovered.targetPath)).toBe(false);
      await retryShootingProjectOutput({ projectId, taskId: recovered.taskId });
      const task = await settled(recovered.taskId);
      expect(task.status).toBe("completed");
      expect(fs.readFileSync(recovered.targetPath)).toEqual(photo.bytes);
      expect(fs.existsSync(recovered.tempPath)).toBe(false);
    });
  }

  it("reconciles a final file committed before its success record without reading the old offline source or overwriting it", async () => {
    const photo = await addPhoto();
    const recovered = await recoveredTask(photo, "committing", true);
    const stamp = fs.statSync(recovered.targetPath).mtimeMs;
    fs.renameSync(sourceRoot, path.join(runtime.root, "disconnected"));
    closeDatabase();
    startShootingProjectOutputServices();
    await retryShootingProjectOutput({ projectId, taskId: recovered.taskId });
    const task = await settled(recovered.taskId);
    expect(task.status).toBe("completed");
    expect(fs.statSync(recovered.targetPath).mtimeMs).toBe(stamp);
    expect(fs.readFileSync(recovered.targetPath)).toEqual(photo.bytes);
    expect(fs.existsSync(recovered.tempPath)).toBe(false);
  });

  it.each([
    "xmp",
    "acr",
  ] as const)("keeps a %s failure separate from the original success and retries the failed file", async (kind) => {
    await addPhoto();
    const sidecar = path.join(sourceRoot, "day-one", `photo.${kind}`);
    fs.writeFileSync(sidecar, "<sidecar>bytes</sidecar>");
    const open = fsp.open.bind(fsp);
    // Let manifest sampling finish, then fail the next sidecar source open.
    const created = await createShootingProjectOutput({
      projectId,
      targetParent,
    });
    const sidecarOpen = vi
      .spyOn(fsp, "open")
      .mockImplementation(async (filename, ...args) => {
        if (String(filename) === sidecar && args[0] === "r") {
          throw Object.assign(new Error("no access"), { code: "EACCES" });
        }
        return await open(filename, ...args);
      });
    const first = await settled(created.id);
    expect(first.status).toBe("failed");
    const original = first.items.find((item) => item.kind === "original");
    expect(original?.status).toBe("completed");
    expect(first.items.find((item) => item.kind === kind)).toMatchObject({
      status: "failed",
      error: "OUTPUT_PERMISSION_DENIED",
    });
    const originalStamp = original && fs.statSync(original.targetPath).mtimeMs;
    sidecarOpen.mockRestore();
    await retryShootingProjectOutput({ projectId, taskId: created.id });
    const retried = await settled(created.id);
    expect(retried.status).toBe("completed");
    expect(original && fs.statSync(original.targetPath).mtimeMs).toBe(
      originalStamp
    );
  });

  it("cancels between chunks, keeps completed files, and explicitly retries the remaining manifest", async () => {
    const first = await addPhoto(
      "00-first.jpg",
      Buffer.from("already completed")
    );
    const photo = await addPhoto(
      "large.jpg",
      Buffer.alloc(4 * 1024 * 1024, 0x4a)
    );
    const open = fsp.open.bind(fsp);
    let cancel: Promise<unknown> | undefined;
    let taskId = "";
    const spy = vi
      .spyOn(fsp, "open")
      .mockImplementation(async (filename, ...args) => {
        const handle = await open(filename, ...args);
        if (String(filename) === photo.sourcePath && args[0] === "r") {
          const read = handle.read.bind(handle);
          handle.read = (async (
            buffer: Buffer,
            offset: number,
            length: number,
            position: number
          ) => {
            if (
              taskId &&
              length === 1024 * 1024 &&
              position >= 1024 * 1024 &&
              !cancel
            ) {
              cancel = cancelShootingProjectOutput({ projectId, taskId });
            }
            return await read(buffer, offset, length, position);
          }) as typeof handle.read;
        }
        return handle;
      });
    const created = await createShootingProjectOutput({
      projectId,
      targetParent,
    });
    taskId = created.id;
    const task = await settled(created.id);
    await cancel;
    expect(task.status).toBe("cancelled");
    expect(task.items.find((item) => item.photoId === first.id)?.status).toBe(
      "completed"
    );
    const cancelledItem = task.items.find((item) => item.photoId === photo.id);
    expect(cancelledItem?.status).toBe("cancelled");
    expect(cancelledItem && fs.existsSync(cancelledItem.targetPath)).toBe(
      false
    );
    spy.mockRestore();
    await retryShootingProjectOutput({ projectId, taskId });
    expect((await settled(taskId)).status).toBe("completed");
  });

  it("retains the receipt when a retry is cancelled while rechecking a completed sidecar", async () => {
    await addPhoto("paired.jpg");
    const sidecar = path.join(sourceRoot, "paired.acr");
    fs.writeFileSync(sidecar, Buffer.alloc(2 * 1024 * 1024, 0x5a));
    const created = await createShootingProjectOutput({
      projectId,
      targetParent,
    });
    const completed = await settled(created.id);
    const committed = completed.items.find((item) => item.kind === "acr");
    expect(committed?.status).toBe("completed");
    const open = fsp.open.bind(fsp);
    let cancel: Promise<unknown> | undefined;
    const spy = vi
      .spyOn(fsp, "open")
      .mockImplementation(async (file, ...args) => {
        const handle = await open(file, ...args);
        if (String(file) === committed?.targetPath) {
          cancel = cancelShootingProjectOutput({
            projectId,
            taskId: created.id,
          });
        }
        return handle;
      });
    await retryShootingProjectOutput({ projectId, taskId: created.id });
    const cancelled = await settled(created.id);
    await cancel;
    spy.mockRestore();
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.items.find((item) => item.kind === "acr")).toMatchObject({
      status: "completed",
      sha256: committed?.sha256,
    });
    await retryShootingProjectOutput({ projectId, taskId: created.id });
    expect((await settled(created.id)).status).toBe("completed");
  });

  it.each([
    "retry",
    "library",
  ] as const)("recovers from temporarily locked committed files after %s verification", async (entry) => {
    await addPhoto("paired.jpg");
    fs.writeFileSync(path.join(sourceRoot, "paired.acr"), "committed edit");
    const task = await createShootingProjectOutput({ projectId, targetParent });
    const completed = await settled(task.id);
    const committed = completed.items.find((item) => item.kind === "acr");
    expect(committed).toBeDefined();
    const stamp = fs.statSync(committed?.targetPath ?? "").mtimeMs;
    const open = fsp.open.bind(fsp);
    const spy = vi
      .spyOn(fsp, "open")
      .mockImplementation(async (file, ...args) => {
        if (String(file) === committed?.targetPath) {
          throw Object.assign(new Error("Temporarily locked"), {
            code: "EACCES",
          });
        }
        return await open(file, ...args);
      });
    if (entry === "retry") {
      await retryShootingProjectOutput({ projectId, taskId: task.id });
    } else {
      await expect(
        resolveShootingProjectCompletedOutputFiles({
          projectId,
          taskId: task.id,
        })
      ).rejects.toMatchObject({ code: "OUTPUT_RECHECK_UNAVAILABLE" });
    }
    const blocked = await settled(task.id);
    expect(blocked.status).toBe("failed");
    expect(blocked.items.find((item) => item.kind === "acr")).toMatchObject({
      status: "completed",
      sha256: committed?.sha256,
      error: "OUTPUT_RECHECK_UNAVAILABLE",
    });
    spy.mockRestore();
    await retryShootingProjectOutput({ projectId, taskId: task.id });
    const restored = await settled(task.id);
    expect(restored.status).toBe("completed");
    expect(
      restored.items.find((item) => item.kind === "acr")?.error
    ).toBeNull();
    expect(fs.statSync(committed?.targetPath ?? "").mtimeMs).toBe(stamp);
    expect(
      await resolveShootingProjectCompletedOutputFiles({
        projectId,
        taskId: task.id,
      })
    ).toHaveLength(1);
  });

  it("retries against the confirmed full sidecar hash when the sampled bytes still match", async () => {
    await addPhoto("paired.nef");
    const source = path.join(sourceRoot, "paired.acr");
    const original = Buffer.alloc(1024 * 1024, 0x5a);
    const stamp = new Date("2026-11-25T00:00:00Z");
    fs.writeFileSync(source, original);
    fs.utimesSync(source, stamp, stamp);
    const fingerprint = await getLightweightFingerprint(source);
    const created = await createShootingProjectOutput({
      projectId,
      targetParent,
    });
    const open = fsp.open.bind(fsp);
    const spy = vi
      .spyOn(fsp, "open")
      .mockImplementation(async (file, ...args) => {
        if (String(file) === source) {
          throw Object.assign(new Error("Temporarily locked"), {
            code: "EACCES",
          });
        }
        return await open(file, ...args);
      });
    const failed = await settled(created.id);
    expect(failed.items.find((item) => item.kind === "acr")?.status).toBe(
      "failed"
    );
    spy.mockRestore();

    const changed = Buffer.from(original);
    changed[256 * 1024] = 0x88;
    fs.writeFileSync(source, changed);
    fs.utimesSync(source, stamp, stamp);
    expect(await getLightweightFingerprint(source)).toBe(fingerprint);
    await retryShootingProjectOutput({ projectId, taskId: created.id });
    const rejected = await settled(created.id);
    expect(rejected.items.find((item) => item.kind === "acr")).toMatchObject({
      status: "failed",
      error: "OUTPUT_SOURCE_CHANGED",
    });
    expect(fs.existsSync(path.join(created.targetRoot, "paired.acr"))).toBe(
      false
    );
  });

  it.each([
    "project",
    "service",
  ] as const)("rejects a late retry after stopping the %s while the source path is being checked", async (scope) => {
    const photo = await addPhoto();
    const task = recoveredTask(photo, "verifying", false);
    startShootingProjectOutputServices();
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    vi.spyOn(fsp, "realpath").mockImplementationOnce(async () => {
      entered.resolve();
      await resume.promise;
      return sourceRoot;
    });
    const result = expect(
      retryShootingProjectOutput({
        projectId,
        taskId: task.taskId,
      })
    ).rejects.toMatchObject({ code: "OUTPUT_BUSY" });
    await entered.promise;
    await stopShootingProjectOutputTasks(
      scope === "project" ? projectId : undefined
    );
    resume.resolve();
    await result;
    expect((await settled(task.taskId)).status).toBe("interrupted");
    expect(fs.existsSync(task.targetPath)).toBe(false);
  });

  it("does not issue an inspection stopped during a source directory scan", async () => {
    await addPhoto();
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const readdir = fsp.readdir.bind(fsp);
    const spy = vi
      .spyOn(fsp, "readdir")
      .mockImplementationOnce(async (...args) => {
        entered.resolve();
        await resume.promise;
        return await readdir(...args);
      });
    const input = { projectId, targetParent };
    const result = expect(
      inspectShootingProjectOutput(input)
    ).rejects.toMatchObject({ code: "OUTPUT_BUSY" });
    await entered.promise;
    await stopShootingProjectOutputTasks(projectId);
    resume.resolve();
    await result;
    spy.mockRestore();
    expect(await inspectShootingProjectOutput(input)).toMatchObject({
      originalCount: 1,
    });
  });

  it("does not reopen the database when stopped while resolving the destination", async () => {
    await addPhoto();
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    vi.spyOn(fsp, "realpath").mockImplementationOnce(async () => {
      entered.resolve();
      await resume.promise;
      return targetParent;
    });
    const result = expect(
      inspectShootingProjectOutput({ projectId, targetParent })
    ).rejects.toMatchObject({ code: "OUTPUT_BUSY" });
    await entered.promise;
    await stopShootingProjectOutputTasks();
    closeDatabase();
    const dbAccess = vi.spyOn(database, "getDatabase");
    resume.resolve();
    await result;
    expect(dbAccess).not.toHaveBeenCalled();
  });

  it("does not write an old verification error after the output service stops", async () => {
    await addPhoto("paired.jpg");
    fs.writeFileSync(path.join(sourceRoot, "paired.acr"), "committed edit");
    const task = await createShootingProjectOutput({ projectId, targetParent });
    const completed = await settled(task.id);
    const sidecar = completed.items.find((item) => item.kind === "acr");
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const open = fsp.open.bind(fsp);
    vi.spyOn(fsp, "open").mockImplementation(async (file, ...args) => {
      if (String(file) === sidecar?.targetPath) {
        entered.resolve();
        await resume.promise;
        throw Object.assign(new Error("Temporarily locked"), {
          code: "EACCES",
        });
      }
      return await open(file, ...args);
    });
    const result = expect(
      resolveShootingProjectCompletedOutputFiles({
        projectId,
        taskId: task.id,
      })
    ).rejects.toMatchObject({ code: "OUTPUT_BUSY" });
    await entered.promise;
    await stopShootingProjectOutputTasks();
    closeDatabase();
    const dbAccess = vi.spyOn(database, "getDatabase");
    resume.resolve();
    await result;
    expect(dbAccess).not.toHaveBeenCalled();
    dbAccess.mockRestore();
    expect((await settled(task.id)).status).toBe("completed");
  });

  it("waits for the confirmed destination folder to roll back when stopped during creation", async () => {
    await addPhoto();
    const input = { projectId, targetParent };
    const inspection = await inspectShootingProjectOutput(input);
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const mkdir = fsp.mkdir.bind(fsp);
    vi.spyOn(fsp, "mkdir").mockImplementationOnce(async (...args) => {
      entered.resolve();
      await resume.promise;
      return await mkdir(...args);
    });
    const result = expect(
      createInspectedOutput({
        ...input,
        inspectionToken: inspection.token,
        decisions: [],
      })
    ).rejects.toMatchObject({ code: "OUTPUT_INSPECTION_EXPIRED" });
    await entered.promise;
    let stopped = false;
    const stop = stopShootingProjectOutputTasks(projectId).then(() => {
      stopped = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(stopped).toBe(false);
    resume.resolve();
    await result;
    await stop;
    expect(fs.readdirSync(targetParent)).toEqual([]);
    expect(await listShootingProjectOutputs(projectId)).toEqual([]);
  });

  it("waits for active writes at shutdown and keeps the task interrupted until explicit resume", async () => {
    const photo = await addPhoto(
      "shutdown.jpg",
      Buffer.alloc(3 * 1024 * 1024, 0x5a)
    );
    const open = fsp.open.bind(fsp);
    let stop: Promise<void> | undefined;
    let taskId = "";
    const spy = vi
      .spyOn(fsp, "open")
      .mockImplementation(async (filename, ...args) => {
        const handle = await open(filename, ...args);
        if (String(filename) === photo.sourcePath && args[0] === "r") {
          const read = handle.read.bind(handle);
          handle.read = (async (
            buffer: Buffer,
            offset: number,
            length: number,
            position: number
          ) => {
            if (
              taskId &&
              length === 1024 * 1024 &&
              position >= 1024 * 1024 &&
              !stop
            ) {
              stop = stopShootingProjectOutputTasks();
            }
            return await read(buffer, offset, length, position);
          }) as typeof handle.read;
        }
        return handle;
      });
    const created = await createShootingProjectOutput({
      projectId,
      targetParent,
    });
    taskId = created.id;
    const task = await settled(taskId);
    await stop;
    spy.mockRestore();
    expect(task.status).toBe("interrupted");
    expect(fs.existsSync(task.items[0].targetPath)).toBe(false);
    closeDatabase();
    startShootingProjectOutputServices();
    expect((await listShootingProjectOutputs(projectId))[0].status).toBe(
      "interrupted"
    );
    expect(fs.existsSync(task.items[0].targetPath)).toBe(false);
    await retryShootingProjectOutput({ projectId, taskId });
    expect((await settled(taskId)).status).toBe("completed");
  });
});
