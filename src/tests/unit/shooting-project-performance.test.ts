/** @vitest-environment node */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import sharp from "sharp";
import { expect, it, vi } from "vitest";
import { closeDatabase, getDatabase } from "@/db";
import { photos } from "@/db/schema";
import { scanFolder, stopScanning, stopWatching } from "@/services/indexer";
import {
  createShootingProject,
  getShootingProjectWorkspace,
  resolveShootingProjectPreview,
  startShootingProjectServices,
  stopShootingProjectServices,
} from "@/services/shooting-projects";
import { initThumbnailer, stopThumbnailer } from "@/services/thumbnailer";
import { TestRuntime } from "../helpers/test-runtime";

const state = vi.hoisted(() => ({
  dataPath: "",
  embedding: vi.fn(),
  colorVector: vi.fn(),
}));
vi.mock("@/utils/data-path", () => ({ getDataPath: () => state.dataPath }));
vi.mock("@/services/ai-embedder", () => ({
  deletePhotoVectors: vi.fn().mockResolvedValue(undefined),
  embedAllPhotos: state.embedding,
}));
vi.mock("@/services/ai/vector-db", () => ({
  upsertColorVector: state.colorVector,
}));

const COUNT = 48;
const WIDTH = 2048;
const HEIGHT = 1365;

async function waitForValue<T>(
  operation: () => Promise<T | null>,
  deadlineMs = 120_000
): Promise<T> {
  const deadline = performance.now() + deadlineMs;
  while (performance.now() < deadline) {
    const value = await operation();
    if (value !== null) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    "Isolated photo preparation did not produce the expected result"
  );
}

async function createDataset(libraryRoot: string, projectRoot: string) {
  const rgb = Buffer.alloc(WIDTH * HEIGHT * 3);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const offset = (y * WIDTH + x) * 3;
      rgb[offset] = (x * 13 + y * 5) % 256;
      rgb[offset + 1] = (y * 11 + Math.floor(x / 19)) % 256;
      rgb[offset + 2] = (x * 7 + y * 3) % 256;
    }
  }
  let sourceBytes = 0;
  for (let index = 0; index < COUNT; index++) {
    const buffer = await sharp(rgb, {
      raw: { width: WIDTH, height: HEIGHT, channels: 3 },
    })
      .modulate({ hue: index * 7 })
      .jpeg({ quality: 92 })
      .toBuffer();
    sourceBytes += buffer.length;
    const relativePath = path.join(
      `part-${Math.floor(index / 16)}`,
      `capture-${String(index).padStart(3, "0")}.jpg`
    );
    for (const root of [libraryRoot, projectRoot]) {
      const filename = path.join(root, relativePath);
      await fs.mkdir(path.dirname(filename), { recursive: true });
      await fs.writeFile(filename, buffer);
    }
  }
  return sourceBytes;
}

async function measureLibrary(libraryRoot: string) {
  const started = performance.now();
  const scanning = scanFolder(libraryRoot);
  const firstPath = await waitForValue(async () => {
    const row = getDatabase()
      .select({ thumbnailPath: photos.thumbnailPath })
      .from(photos)
      .all()
      .find((photo) => photo.thumbnailPath);
    if (!row?.thumbnailPath) {
      return null;
    }
    await sharp(await fs.readFile(row.thumbnailPath)).metadata();
    return row.thumbnailPath;
  });
  const firstViewMs = performance.now() - started;
  const result = await scanning;
  const batchMs = performance.now() - started;
  expect(result.newPhotoIds).toHaveLength(COUNT);
  expect(result.failed).toBe(0);
  expect(firstPath).toBeTruthy();
  return {
    firstViewMs,
    batchMs,
    photos: result.newPhotoIds.length,
    measurement:
      "scanFolder start to first persisted thumbnail read and JPEG/WebP metadata decode; semantic AI excluded",
  };
}

function timings(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    samples: values.length,
    meanMs: values.reduce((total, value) => total + value, 0) / values.length,
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
    maxMs: sorted.at(-1) ?? 0,
  };
}

async function measureProject(projectRoot: string) {
  const started = performance.now();
  const project = await createShootingProject({
    sourceRoot: projectRoot,
    name: "Fixed JPEG performance fixture",
  });
  await getShootingProjectWorkspace(project.id);
  await waitForValue(async () => {
    const workspace = await getShootingProjectWorkspace(project.id);
    const photo = workspace.photos.find(
      (item) => item.previewStatus === "ready"
    );
    if (!photo) {
      return null;
    }
    const preview = await resolveShootingProjectPreview(project.id, photo.id);
    if (!preview) {
      return null;
    }
    await sharp(await fs.readFile(preview)).metadata();
    return photo.id;
  });
  const firstViewMs = performance.now() - started;
  const workspace = await waitForValue(async () => {
    const value = await getShootingProjectWorkspace(project.id);
    return value.scan.status === "completed" &&
      value.project.previewReadyCount === COUNT
      ? value
      : null;
  });
  const batchMs = performance.now() - started;
  const cacheRead: number[] = [];
  const cacheReadAndDecode: number[] = [];
  for (const photo of workspace.photos) {
    const hitStarted = performance.now();
    const preview = await resolveShootingProjectPreview(project.id, photo.id);
    if (!preview) {
      throw new Error("Expected a resident project preview");
    }
    const buffer = await fs.readFile(preview);
    cacheRead.push(performance.now() - hitStarted);
    await sharp(buffer).metadata();
    cacheReadAndDecode.push(performance.now() - hitStarted);
  }
  expect(workspace.photos).toHaveLength(COUNT);
  expect(workspace.counts.pending).toBe(COUNT);
  expect(getDatabase().select().from(photos).all()).toHaveLength(COUNT);
  return {
    firstViewMs,
    batchMs,
    previewBytes: workspace.previewBytes,
    cacheRead: timings(cacheRead),
    cacheReadAndMetadataDecode: timings(cacheReadAndDecode),
    measurement:
      "project creation start to first independent preview read; batch ends when 48 independent previews are ready; cache values measure service+filesystem, not renderer paint",
  };
}

const STEP_COMPARISON = {
  type: "static workflow comparison, not an observed click trace",
  project: {
    setup: [
      "open shooting projects",
      "new project and select source",
      "confirm project name",
    ],
    handoff: [
      "copy kept originals",
      "select output parent and confirm manifest",
      "open completed output",
    ],
    reopen: ["open shooting projects", "open saved project"],
  },
  legacyLibraryZip: {
    setup: [
      "add library folder",
      "wait for library preparation",
      "open cull sessions",
      "create session and choose library source",
    ],
    handoff: [
      "open results",
      "export kept photos as ZIP",
      "choose destination",
      "extract ZIP",
      "open extracted folder",
    ],
    reopen: ["open cull sessions", "resume saved session"],
  },
  selection:
    "Each explicit keep/reject/undecided judgment remains a user action; the project does not claim fewer judgment operations.",
  note: "The legacy path intentionally compares the existing cull ZIP handoff. Manual Explorer copying and other routes are outside this step count. AI waiting is excluded from measured times and is not counted as a click.",
};

it("records a fixed 48-JPEG local baseline without an unmeasured performance SLA", async () => {
  const runtime = new TestRuntime("shooting-project-performance");
  const previousCache = sharp.cache();
  const libraryRoot = path.join(runtime.root, "library-source");
  const projectRoot = path.join(runtime.root, "project-source");
  state.dataPath = path.join(runtime.root, "profile");
  vi.stubEnv("APPDATA", runtime.root);
  state.colorVector.mockResolvedValue(undefined);
  sharp.cache(false);
  try {
    const sourceBytes = await createDataset(libraryRoot, projectRoot);
    initThumbnailer();
    startShootingProjectServices();
    const library = await measureLibrary(libraryRoot);
    const project = await measureProject(projectRoot);
    expect(state.embedding).not.toHaveBeenCalled();
    const report = {
      schemaVersion: 1,
      machine: {
        platform: process.platform,
        arch: process.arch,
        osRelease: os.release(),
        cpu: os.cpus()[0]?.model,
        logicalCpus: os.cpus().length,
        totalMemoryBytes: os.totalmem(),
        node: process.versions.node,
        electron: process.versions.electron,
      },
      dataset: {
        count: COUNT,
        width: WIDTH,
        height: HEIGHT,
        channels: 3,
        jpegQuality: 92,
        sourceBytes,
        origin:
          "deterministic generated RGB photographic-size textures; identical bytes in separate isolated roots",
        imageVariation: "spatial RGB pattern with 48 hue rotations",
      },
      methodology: {
        order: "library then project",
        aiProcessing:
          "disabled; color-vector persistence is mocked because it is outside preview readiness",
        applicationCaches:
          "fresh task-owned application data; libvips file cache disabled for fixture handle release",
        operatingSystemCache:
          "not flushed; source files were generated immediately before both runs",
        pollingResolutionMs: 10,
        trials: 1,
        limits:
          "one-machine baseline; cached read/metadata decode is a service proxy, not actual renderer presentation or full photograph detail inspection",
      },
      library,
      project,
      operations: STEP_COMPARISON,
    };
    const output = process.env.AIM_SHOOTING_PERF_OUTPUT;
    if (output) {
      const resolved = path.resolve(output);
      const relative = path.relative(path.resolve(".test-runtime"), resolved);
      if (
        path.isAbsolute(relative) ||
        relative.startsWith("..") ||
        path.extname(resolved).toLowerCase() !== ".json"
      ) {
        throw new Error(
          "Performance output must be a task-owned JSON below .test-runtime"
        );
      }
      await fs.mkdir(path.dirname(resolved), { recursive: true });
      await fs.writeFile(resolved, `${JSON.stringify(report, null, 2)}\n`);
    }
    console.log(
      "[shooting-project-performance]",
      JSON.stringify({ library, project })
    );
  } finally {
    stopScanning();
    await stopWatching();
    await stopShootingProjectServices();
    await stopThumbnailer();
    closeDatabase();
    sharp.cache({
      memory: previousCache.memory.max,
      files: previousCache.files.max,
      items: previousCache.items.max,
    });
    vi.unstubAllEnvs();
    expect(runtime.cleanup().status).toBe("deleted");
  }
}, 120_000);
