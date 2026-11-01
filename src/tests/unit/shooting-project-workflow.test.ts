/** @vitest-environment node */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, getDatabase } from "@/db";
import {
  photos,
  shootingProjectActions,
  shootingProjectOutputItems,
  shootingProjectOutputs,
  shootingProjectPhotos,
  shootingProjects,
} from "@/db/schema";
import {
  getLightweightFingerprint,
  hashProjectFile,
  projectPreviewDirectory,
  resolveProjectRelativePath,
  validateProjectPreviewLocation,
} from "@/services/shooting-project-files";
import {
  archiveShootingProject,
  clearShootingProjectPreviews,
  commitShootingProjectRelink,
  createShootingProject,
  deleteShootingProject,
  getShootingProjectWorkspace,
  inspectShootingProjectRelink,
  listShootingProjects,
  openShootingProject,
  prepareShootingProject,
  prioritizeShootingProjectPreviews,
  renameShootingProject,
  resolveShootingProjectPreview,
  saveShootingProjectBrowse,
  setShootingProjectSelection,
  startShootingProjectServices,
  stopShootingProjectServices,
  undoShootingProjectSelection,
} from "@/services/shooting-projects";
import type { ShootingProjectWorkspaceData } from "@/types/shooting-project";
import { TestRuntime } from "../helpers/test-runtime";

const state = vi.hoisted(() => ({
  dataPath: "",
  rawPreview: vi.fn(),
  rawDimensions: vi.fn(),
}));
vi.mock("@/utils/data-path", () => ({ getDataPath: () => state.dataPath }));
vi.mock("@/services/raw-preview", async (original) => ({
  ...(await original<typeof import("@/services/raw-preview")>()),
  extractRawPreview: state.rawPreview,
  readRawDimensions: state.rawDimensions,
}));
vi.mock("@/services/import-queue", () => {
  throw new Error("Project preparation must not import library queue");
});
vi.mock("@/services/indexer", () => {
  throw new Error("Project preparation must not import library scanner");
});
vi.mock("@/services/ai-embedder", () => {
  throw new Error("Project preparation must not import AI");
});

let runtime: TestRuntime;
let sourceRoot: string;

beforeEach(async () => {
  runtime = new TestRuntime("shooting-project-workflow");
  state.dataPath = path.join(runtime.root, "profile");
  sourceRoot = path.join(runtime.root, "source");
  fs.mkdirSync(sourceRoot, { recursive: true });
  vi.stubEnv("APPDATA", runtime.root);
  state.rawPreview.mockReset();
  state.rawDimensions.mockReset();
  startShootingProjectServices();
  await image("one.jpg", "red");
  await image("sub/two.png", "blue");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await stopShootingProjectServices();
  closeDatabase();
  vi.unstubAllEnvs();
  // Synchronous removal retries cannot drain pending filesystem close callbacks.
  await vi.waitFor(() => expect(runtime.cleanup().status).toBe("deleted"), {
    timeout: 5000,
  });
});

async function image(relativePath: string, background: string) {
  const filename = path.join(sourceRoot, relativePath);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  await sharp({ create: { width: 96, height: 64, channels: 3, background } })
    .jpeg({ quality: 90 })
    .toFile(filename);
  return filename;
}

async function settled(
  projectId: string,
  test: (workspace: ShootingProjectWorkspaceData) => boolean = (workspace) =>
    workspace.scan.status === "completed" &&
    workspace.photos.every((photo) => photo.previewStatus !== "pending")
) {
  let workspace = await getShootingProjectWorkspace(projectId);
  await vi.waitFor(
    async () => {
      workspace = await getShootingProjectWorkspace(projectId);
      expect(test(workspace)).toBe(true);
    },
    { timeout: 12_000, interval: 15 }
  );
  return workspace;
}

async function prepared() {
  const project = await createShootingProject({ sourceRoot, name: "拍摄" });
  return await settled(project.id);
}

describe("shooting project preparation and persistence", () => {
  it("prepares a full HEIC preview for direct culling without library import", async () => {
    fs.copyFileSync(
      path.resolve("src/tests/fixtures/heif/example.heic"),
      path.join(sourceRoot, "HEIC.heic")
    );
    const workspace = await prepared();
    const photo = workspace.photos.find(
      (item) => item.filename === "HEIC.heic"
    );
    expect(photo).toMatchObject({
      previewStatus: "ready",
      width: 1280,
      height: 854,
    });
    if (!photo) {
      throw new Error("Missing HEIC project photo");
    }
    const preview = await resolveShootingProjectPreview(
      workspace.project.id,
      photo.id
    );
    if (!preview) {
      throw new Error("Missing HEIC project preview");
    }
    expect(await sharp(preview).metadata()).toMatchObject({
      format: "jpeg",
      width: 1280,
      height: 854,
    });
    expect(getDatabase().select().from(photos).all()).toHaveLength(0);
  });

  it("uses the unfiltered format contract for new workspaces and upgrades legacy browse state", async () => {
    const workspace = await prepared();
    expect(workspace.photos).toHaveLength(2);
    expect(workspace.browsing.format).toBe("");
    getDatabase()
      .update(shootingProjects)
      .set({
        browsingJson: JSON.stringify({ ...workspace.browsing, format: "all" }),
      })
      .where(eq(shootingProjects.id, workspace.project.id))
      .run();

    const legacy = await getShootingProjectWorkspace(workspace.project.id);
    expect(legacy.browsing.format).toBe("");
    const stored = getDatabase()
      .select()
      .from(shootingProjects)
      .where(eq(shootingProjects.id, workspace.project.id))
      .get();
    expect(JSON.parse(stored?.browsingJson ?? "{}").format).toBe("");

    await saveShootingProjectBrowse({
      projectId: workspace.project.id,
      browsing: { ...legacy.browsing, format: "jpg" },
    });
    expect(
      (await getShootingProjectWorkspace(workspace.project.id)).browsing.format
    ).toBe("jpg");
  });

  it("discovers recursively and generates independent offline previews without library writes", async () => {
    const workspace = await prepared();
    expect(workspace.photos).toHaveLength(2);
    expect(workspace.project.previewReadyCount).toBe(2);
    expect(workspace.previewBytes).toBeGreaterThan(0);
    expect(workspace.project.coverPhotoId).toBeTruthy();
    expect(workspace.counts).toMatchObject({
      pending: 2,
      reviewed: 0,
      decided: 0,
      allDecided: false,
    });
    expect(getDatabase().select().from(photos).all()).toEqual([]);
    for (const photo of workspace.photos) {
      const preview = await resolveShootingProjectPreview(
        workspace.project.id,
        photo.id
      );
      expect(
        preview?.startsWith(projectPreviewDirectory(workspace.project.id))
      ).toBe(true);
      if (!preview) {
        throw new Error("Expected managed preview");
      }
      expect((await sharp(fs.readFileSync(preview)).metadata()).format).toBe(
        "jpeg"
      );
    }
    const readDirectory = vi.spyOn(fsp, "opendir");
    await getShootingProjectWorkspace(workspace.project.id);
    await getShootingProjectWorkspace(workspace.project.id);
    expect(readDirectory).not.toHaveBeenCalled();
  });

  it("keeps cached images and four-state decisions across an offline database reopen", async () => {
    const workspace = await prepared();
    const first = workspace.photos[0];
    await setShootingProjectSelection({
      projectId: workspace.project.id,
      photoIds: [first.id],
      status: "undecided",
    });
    await stopShootingProjectServices();
    fs.renameSync(sourceRoot, path.join(runtime.root, "disconnected"));
    closeDatabase();
    startShootingProjectServices();
    await openShootingProject(workspace.project.id);
    const offline = await getShootingProjectWorkspace(workspace.project.id);
    expect(offline.project.sourceStatus).toBe("offline");
    expect(offline.photos.find((photo) => photo.id === first.id)?.status).toBe(
      "undecided"
    );
    expect(
      await resolveShootingProjectPreview(workspace.project.id, first.id)
    ).not.toBeNull();
    const kept = await setShootingProjectSelection({
      projectId: workspace.project.id,
      photoIds: [first.id],
      status: "kept",
    });
    expect(kept.counts).toMatchObject({
      kept: 1,
      undecided: 0,
      reviewed: 1,
      decided: 1,
    });
  });

  it("does not reorder an established sequence when EXIF is completed or new photos arrive", async () => {
    const workspace = await prepared();
    const current = workspace.browsing.orderedPhotoIds.at(-1);
    if (!current) {
      throw new Error("Expected a current photo");
    }
    const browsing = {
      ...workspace.browsing,
      currentPhotoId: current,
      view: "grid" as const,
      filter: "kept" as const,
      gridScrollTop: 137,
    };
    await saveShootingProjectBrowse({
      projectId: workspace.project.id,
      browsing,
    });
    getDatabase()
      .update(shootingProjectPhotos)
      .set({ dateTaken: 1 })
      .where(eq(shootingProjectPhotos.id, current))
      .run();
    await setShootingProjectSelection({
      projectId: workspace.project.id,
      photoIds: [current],
      status: "kept",
    });
    await image("new.jpg", "green");
    await prepareShootingProject({
      projectId: workspace.project.id,
      checkNew: true,
    });
    const updated = await settled(workspace.project.id);
    expect(updated.photos).toHaveLength(3);
    expect(updated.browsing).toMatchObject({
      currentPhotoId: current,
      filter: "kept",
      view: "grid",
      gridScrollTop: 137,
    });
    expect(updated.browsing.orderedPhotoIds.slice(0, 2)).toEqual(
      workspace.browsing.orderedPhotoIds
    );
    expect(updated.photos.find((photo) => photo.id === current)?.status).toBe(
      "kept"
    );
    await prepareShootingProject({
      projectId: workspace.project.id,
      checkNew: true,
    });
    expect((await settled(workspace.project.id)).photos).toHaveLength(3);
  });

  it("records scan errors and preview failures separately without declaring all decisions complete", async () => {
    fs.writeFileSync(path.join(sourceRoot, "corrupt.jpg"), "broken image");
    const project = await createShootingProject({ sourceRoot });
    const read = vi
      .spyOn(fsp, "readdir")
      .mockRejectedValueOnce(
        Object.assign(new Error("access denied"), { code: "EACCES" })
      );
    const failed = await settled(
      project.id,
      (workspace) => workspace.scan.status === "failed"
    );
    expect(failed.scan.errors).toContainEqual({
      relativePath: ".",
      code: "EACCES",
    });
    expect(failed.counts.allDecided).toBe(false);
    read.mockRestore();
    await prepareShootingProject({ projectId: project.id, checkNew: true });
    const completed = await settled(project.id);
    expect(completed.photos).toHaveLength(3);
    expect(
      completed.photos.find((photo) => photo.filename === "corrupt.jpg")
    ).toMatchObject({ status: "pending", previewStatus: "failed" });
    expect(completed.scan.errors).toEqual([]);
  });

  it("resumes an interrupted first scan without duplicating records", async () => {
    const project = await createShootingProject({ sourceRoot });
    let release!: (value: never[]) => void;
    const gate = new Promise<never[]>((resolve) => {
      release = resolve;
    });
    const read = vi.spyOn(fsp, "readdir").mockReturnValueOnce(gate);
    await getShootingProjectWorkspace(project.id);
    const closing = stopShootingProjectServices();
    release([]);
    await closing;
    expect(
      getDatabase().select().from(shootingProjects).get()?.scanStatus
    ).toBe("interrupted");
    read.mockRestore();
    closeDatabase();
    startShootingProjectServices();
    await openShootingProject(project.id);
    expect((await settled(project.id)).photos).toHaveLength(2);
  });

  it("keeps changed and missing original records instead of resetting their selections", async () => {
    const workspace = await prepared();
    await setShootingProjectSelection({
      projectId: workspace.project.id,
      photoIds: workspace.photos.map((photo) => photo.id),
      status: "kept",
    });
    fs.renameSync(
      path.join(sourceRoot, "sub/two.png"),
      path.join(runtime.root, "two-offline.png")
    );
    const onePath = path.join(sourceRoot, "one.jpg");
    const original = fs.statSync(onePath);
    const bytes = fs.readFileSync(onePath);
    bytes[bytes.length - 3] = ((bytes.at(-3) ?? 0) + 1) % 256;
    fs.writeFileSync(onePath, bytes);
    fs.utimesSync(onePath, original.atime, original.mtime);
    await prepareShootingProject({
      projectId: workspace.project.id,
      checkNew: true,
    });
    const updated = await settled(workspace.project.id);
    expect(updated.photos.map((photo) => photo.sourceStatus).sort()).toEqual([
      "changed",
      "missing",
    ]);
    expect(updated.counts.kept).toBe(2);
    expect(updated.project.previewReadyCount).toBe(2);
  });
});

describe("shooting project decisions and management", () => {
  it("saves batch decisions with one undo receipt and restores exact previous states", async () => {
    const workspace = await prepared();
    const ids = workspace.photos.map((photo) => photo.id);
    await setShootingProjectSelection({
      projectId: workspace.project.id,
      photoIds: [ids[0]],
      status: "undecided",
    });
    const rejected = await setShootingProjectSelection({
      projectId: workspace.project.id,
      photoIds: ids,
      status: "rejected",
    });
    expect(rejected.counts).toMatchObject({ rejected: 2, allDecided: true });
    const undone = await undoShootingProjectSelection(workspace.project.id);
    expect(undone.counts).toMatchObject({
      pending: 1,
      undecided: 1,
      decided: 0,
      reviewed: 1,
      allDecided: false,
    });
    expect(
      getDatabase().select().from(shootingProjectActions).all()
    ).toHaveLength(1);
    await undoShootingProjectSelection(workspace.project.id);
    expect(
      (await getShootingProjectWorkspace(workspace.project.id)).counts.pending
    ).toBe(2);
    expect(getDatabase().select().from(photos).all()).toEqual([]);
  });

  it("rolls back an entire batch when an ID belongs to another project", async () => {
    const workspace = await prepared();
    await expect(
      setShootingProjectSelection({
        projectId: workspace.project.id,
        photoIds: [workspace.photos[0].id, randomUUID()],
        status: "kept",
      })
    ).rejects.toMatchObject({ code: "INVALID_PHOTO" });
    expect(
      (await getShootingProjectWorkspace(workspace.project.id)).counts.pending
    ).toBe(2);
    expect(getDatabase().select().from(shootingProjectActions).all()).toEqual(
      []
    );
  });

  it("clears owned previews without immediately rebuilding them and preserves foreign files", async () => {
    const workspace = await prepared();
    const directory = projectPreviewDirectory(workspace.project.id);
    const foreign = path.join(directory, `${randomUUID()}.jpg`);
    fs.writeFileSync(foreign, "not owned by a project photo");
    fs.writeFileSync(
      path.join(directory, `${workspace.photos[0].id}.jpg.pending`),
      "foreign staging name"
    );
    await clearShootingProjectPreviews(workspace.project.id);
    const cleared = await settled(workspace.project.id, (value) =>
      value.photos.every((photo) => photo.sourceStatus === "available")
    );
    expect(cleared.project.previewReadyCount).toBe(0);
    expect(cleared.previewBytes).toBe(0);
    expect(fs.readFileSync(foreign, "utf8")).toBe(
      "not owned by a project photo"
    );
    expect(fs.readdirSync(directory)).toHaveLength(2);
    await prioritizeShootingProjectPreviews({
      projectId: workspace.project.id,
      photoIds: [workspace.photos[0].id],
    });
    expect(
      (
        await settled(
          workspace.project.id,
          (value) => value.project.previewReadyCount === 1
        )
      ).project.previewReadyCount
    ).toBe(1);
    await prepareShootingProject({
      projectId: workspace.project.id,
      retryPreviews: true,
    });
    const restored = await settled(
      workspace.project.id,
      (value) =>
        value.project.previewReadyCount === 2 &&
        value.photos.every((photo) => photo.previewStatus === "ready")
    );
    expect(
      restored.photos.every((photo) => photo.previewStatus === "ready")
    ).toBe(true);
  });

  it("recovers the recorded staging file after a restart without sweeping foreign pending files", async () => {
    const workspace = await prepared();
    const projectId = workspace.project.id;
    const photo = workspace.photos[0];
    await stopShootingProjectServices();
    const directory = projectPreviewDirectory(projectId);
    const pendingName = `${photo.id}-${randomUUID()}.jpg.pending`;
    const pending = path.join(directory, pendingName);
    const foreignNames = [
      `${photo.id}-${randomUUID()}.jpg.pending`,
      `${photo.id}.jpg.pending`,
    ];
    fs.writeFileSync(pending, "partially written managed preview");
    for (const name of foreignNames) {
      fs.writeFileSync(path.join(directory, name), "foreign staging file");
    }
    getDatabase()
      .update(shootingProjectPhotos)
      .set({
        previewStatus: "pending",
        previewRelativePath: pendingName,
        previewBytes: 0,
      })
      .where(eq(shootingProjectPhotos.id, photo.id))
      .run();
    closeDatabase();

    startShootingProjectServices();
    const resumed = await settled(projectId);
    expect(resumed.project.previewReadyCount).toBe(2);
    expect(fs.existsSync(pending)).toBe(false);
    expect(
      getDatabase()
        .select()
        .from(shootingProjectPhotos)
        .where(eq(shootingProjectPhotos.id, photo.id))
        .get()?.previewRelativePath
    ).toBe(`${photo.id}.jpg`);
    await deleteShootingProject(projectId);
    expect(fs.readdirSync(directory).sort()).toEqual(foreignNames.sort());
    for (const name of foreignNames) {
      expect(fs.readFileSync(path.join(directory, name), "utf8")).toBe(
        "foreign staging file"
      );
    }
  });

  it("refuses a recorded staging file replaced by a link when rebuilding previews", async () => {
    const workspace = await prepared();
    const projectId = workspace.project.id;
    const photo = workspace.photos[0];
    await stopShootingProjectServices();
    const directory = projectPreviewDirectory(projectId);
    const pendingName = `${photo.id}-${randomUUID()}.jpg.pending`;
    const pending = path.join(directory, pendingName);
    const foreignDirectory = path.join(runtime.root, "foreign-preview-data");
    fs.mkdirSync(foreignDirectory);
    const foreign = path.join(foreignDirectory, "keep.jpg");
    fs.writeFileSync(foreign, "foreign content");
    fs.symlinkSync(
      foreignDirectory,
      pending,
      process.platform === "win32" ? "junction" : "dir"
    );
    try {
      getDatabase()
        .update(shootingProjectPhotos)
        .set({ previewStatus: "pending", previewRelativePath: pendingName })
        .where(eq(shootingProjectPhotos.id, photo.id))
        .run();
      startShootingProjectServices();
      const resumed = await settled(projectId);
      expect(resumed.photos.find((item) => item.id === photo.id)).toMatchObject(
        {
          previewStatus: "failed",
          previewError: "PROTECTED_PATH",
        }
      );
      expect(fs.lstatSync(pending).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(foreign, "utf8")).toBe("foreign content");
    } finally {
      await stopShootingProjectServices();
      fs.unlinkSync(pending);
    }
  });

  it("archives and restores records, then deletes only managed project data with output cascades", async () => {
    const workspace = await prepared();
    await renameShootingProject({
      projectId: workspace.project.id,
      name: "改名",
    });
    await archiveShootingProject({
      projectId: workspace.project.id,
      archived: true,
    });
    expect(await listShootingProjects({})).toEqual([]);
    expect((await listShootingProjects({ archived: true }))[0].name).toBe(
      "改名"
    );
    await archiveShootingProject({
      projectId: workspace.project.id,
      archived: false,
    });
    const taskId = randomUUID();
    const target = path.join(runtime.root, "delivered.jpg");
    fs.writeFileSync(target, "user output");
    getDatabase()
      .insert(shootingProjectOutputs)
      .values({
        id: taskId,
        projectId: workspace.project.id,
        targetRoot: runtime.root,
        createdAt: 1,
      })
      .run();
    getDatabase()
      .insert(shootingProjectOutputItems)
      .values({
        id: randomUUID(),
        taskId,
        photoId: workspace.photos[0].id,
        kind: "original",
        relativePath: "one.jpg",
        sourcePath: path.join(sourceRoot, "one.jpg"),
        targetPath: target,
        tempPath: `${target}.pending`,
        fileSize: 11,
        modifiedAt: 1,
      })
      .run();
    await deleteShootingProject(workspace.project.id);
    expect(getDatabase().select().from(shootingProjects).all()).toEqual([]);
    expect(getDatabase().select().from(shootingProjectPhotos).all()).toEqual(
      []
    );
    expect(getDatabase().select().from(shootingProjectOutputs).all()).toEqual(
      []
    );
    expect(
      getDatabase().select().from(shootingProjectOutputItems).all()
    ).toEqual([]);
    expect(fs.readFileSync(target, "utf8")).toBe("user output");
    expect(fs.existsSync(path.join(sourceRoot, "one.jpg"))).toBe(true);
    expect(fs.existsSync(projectPreviewDirectory(workspace.project.id))).toBe(
      false
    );
  });
});

describe("root reassociation and filesystem boundaries", () => {
  it("requires explicit acceptance of sampled candidates and preserves stable IDs and decisions", async () => {
    const workspace = await prepared();
    await setShootingProjectSelection({
      projectId: workspace.project.id,
      photoIds: [workspace.photos[0].id],
      status: "kept",
    });
    const relocated = path.join(runtime.root, "relocated");
    await stopShootingProjectServices();
    await fsp.rename(sourceRoot, relocated);
    startShootingProjectServices();
    await openShootingProject(workspace.project.id);
    const inspection = await inspectShootingProjectRelink({
      projectId: workspace.project.id,
      sourceRoot: relocated,
    });
    expect(inspection).toMatchObject({
      verified: 0,
      candidates: 2,
      changed: 0,
      missing: 0,
      insufficient: 0,
    });
    await expect(
      commitShootingProjectRelink({
        projectId: workspace.project.id,
        token: inspection.token,
        acceptCandidates: false,
      })
    ).rejects.toMatchObject({ code: "RELINK_CONFIRMATION_REQUIRED" });
    await commitShootingProjectRelink({
      projectId: workspace.project.id,
      token: inspection.token,
      acceptCandidates: true,
    });
    const linked = await settled(workspace.project.id, (value) =>
      value.photos.every((photo) => photo.sourceStatus === "available")
    );
    expect(linked.photos.map((photo) => photo.id)).toEqual(
      workspace.photos.map((photo) => photo.id)
    );
    expect(linked.counts.kept).toBe(1);
    expect(linked.project.sourceRoot).toBe(relocated);
  });

  it("distinguishes historical full-hash matches from insufficient evidence and changed files", async () => {
    const workspace = await prepared();
    const row = workspace.photos[0];
    getDatabase()
      .update(shootingProjectPhotos)
      .set({
        contentHash: await hashProjectFile(
          path.join(sourceRoot, row.relativePath)
        ),
      })
      .where(eq(shootingProjectPhotos.id, row.id))
      .run();
    const second = workspace.photos[1];
    getDatabase()
      .update(shootingProjectPhotos)
      .set({ lightweightFingerprint: null })
      .where(eq(shootingProjectPhotos.id, second.id))
      .run();
    const relocated = path.join(runtime.root, "new-root");
    fs.cpSync(sourceRoot, relocated, {
      recursive: true,
      preserveTimestamps: true,
    });
    const inspection = await inspectShootingProjectRelink({
      projectId: workspace.project.id,
      sourceRoot: relocated,
    });
    expect(inspection).toMatchObject({
      verified: 1,
      candidates: 0,
      insufficient: 1,
    });
    await commitShootingProjectRelink({
      projectId: workspace.project.id,
      token: inspection.token,
      acceptCandidates: true,
    });
    const linked = await settled(
      workspace.project.id,
      (value) =>
        value.photos.find((photo) => photo.id === row.id)?.sourceStatus ===
        "available"
    );
    expect(
      linked.photos.find((photo) => photo.id === second.id)?.sourceStatus
    ).toBe("unverified");
    const changed = fs.readFileSync(path.join(relocated, row.relativePath));
    changed[changed.length - 4] = ((changed.at(-4) ?? 0) + 2) % 256;
    fs.writeFileSync(path.join(relocated, row.relativePath), changed);
    expect(
      (
        await inspectShootingProjectRelink({
          projectId: workspace.project.id,
          sourceRoot: relocated,
        })
      ).changed
    ).toBe(1);
  });

  it("revalidates candidate files when the user commits an inspection", async () => {
    const workspace = await prepared();
    const relocated = path.join(runtime.root, "new-root");
    fs.cpSync(sourceRoot, relocated, {
      recursive: true,
      preserveTimestamps: true,
    });
    const inspection = await inspectShootingProjectRelink({
      projectId: workspace.project.id,
      sourceRoot: relocated,
    });
    fs.writeFileSync(
      path.join(relocated, workspace.photos[0].relativePath),
      "replacement"
    );
    await expect(
      commitShootingProjectRelink({
        projectId: workspace.project.id,
        token: inspection.token,
        acceptCandidates: true,
      })
    ).rejects.toMatchObject({ code: "RELINK_EXPIRED" });
    expect(
      getDatabase().select().from(shootingProjects).get()?.sourceRoot
    ).toBe(sourceRoot);
  });

  it("expires a relink inspection when scanning adds photos before confirmation", async () => {
    const workspace = await prepared();
    const projectId = workspace.project.id;
    const relocated = path.join(runtime.root, "new-root");
    fs.cpSync(sourceRoot, relocated, {
      recursive: true,
      preserveTimestamps: true,
    });
    const inspection = await inspectShootingProjectRelink({
      projectId,
      sourceRoot: relocated,
    });
    expect(inspection.candidates).toBe(2);

    await image("discovered-after-inspection.jpg", "green");
    await prepareShootingProject({ projectId, checkNew: true });
    const updated = await settled(projectId);
    expect(updated.photos).toHaveLength(3);
    const added = updated.photos.find(
      (photo) => photo.relativePath === "discovered-after-inspection.jpg"
    );
    expect(added).toBeDefined();
    await setShootingProjectSelection({
      projectId,
      photoIds: [added?.id as string],
      status: "kept",
    });
    const db = getDatabase();
    const before = db.select().from(shootingProjectPhotos).all();
    await expect(
      commitShootingProjectRelink({
        projectId,
        token: inspection.token,
        acceptCandidates: true,
      })
    ).rejects.toMatchObject({ code: "RELINK_EXPIRED" });
    expect(db.select().from(shootingProjects).get()?.sourceRoot).toBe(
      sourceRoot
    );
    expect(db.select().from(shootingProjectPhotos).all()).toEqual(before);
  });

  it("rejects traversal and protects a managed parent directory link and Temp ancestry", async () => {
    await expect(
      resolveProjectRelativePath(sourceRoot, "../outside.jpg")
    ).rejects.toMatchObject({ code: "INVALID_SOURCE" });
    const project = await createShootingProject({ sourceRoot });
    const previews = path.join(state.dataPath, "shooting-projects");
    const foreign = path.join(runtime.root, "foreign");
    fs.mkdirSync(foreign);
    fs.symlinkSync(
      foreign,
      previews,
      process.platform === "win32" ? "junction" : "dir"
    );
    await expect(
      validateProjectPreviewLocation(project.id, true)
    ).rejects.toMatchObject({ code: "PROTECTED_PATH" });
    // Remove only this test's directory link, never its target contents.
    fs.unlinkSync(previews);
    const previousDataPath = state.dataPath;
    state.dataPath = path.join(runtime.root, "Temp", "profile");
    await expect(
      validateProjectPreviewLocation(project.id, true)
    ).rejects.toMatchObject({ code: "PROTECTED_PATH" });
    expect(fs.existsSync(path.join(runtime.root, "Temp"))).toBe(false);
    state.dataPath = previousDataPath;
    expect(
      (await getLightweightFingerprint(path.join(sourceRoot, "one.jpg"))).length
    ).toBe(64);
  });

  it("uses extracted RAW previews while keeping original and preview dimensions separate", async () => {
    const jpeg = await sharp({
      create: { width: 160, height: 100, channels: 3, background: "green" },
    })
      .jpeg()
      .toBuffer();
    fs.writeFileSync(
      path.join(sourceRoot, "camera.dng"),
      "simulated RAW container for extraction boundary"
    );
    state.rawPreview.mockResolvedValue(jpeg);
    state.rawDimensions.mockResolvedValue({ width: 6000, height: 4000 });
    const workspace = await prepared();
    const raw = workspace.photos.find((photo) => photo.format === "dng");
    expect(raw).toMatchObject({
      width: 6000,
      height: 4000,
      previewWidth: 160,
      previewHeight: 100,
      previewStatus: "ready",
    });
    expect(state.rawPreview).toHaveBeenCalledWith(
      path.join(sourceRoot, "camera.dng")
    );
  });
});
