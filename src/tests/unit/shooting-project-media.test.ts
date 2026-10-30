/** @vitest-environment node */
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, getDatabase } from "@/db";
import { photos, shootingProjectPhotos } from "@/db/schema";
import { getPhotoExif, getPhotoMedia } from "@/ipc/cull/media";
import {
  getHttpServerAuthToken,
  startHttpServerEarly,
  stopHttpServer,
} from "@/services/http-server";
import {
  loadProjectCullRows,
  startProjectCullSession,
} from "@/services/project-cull";
import {
  readProjectExif,
  resolveShootingProjectOriginal,
} from "@/services/shooting-project-media";
import {
  createShootingProject,
  getShootingProjectWorkspace,
  startShootingProjectServices,
  stopShootingProjectServices,
} from "@/services/shooting-projects";
import { TestRuntime } from "../helpers/test-runtime";

const state = vi.hoisted(() => ({ root: "" }));
vi.mock("@/utils/data-path", () => ({ getDataPath: () => state.root }));
vi.mock("@/utils/folder-paths", () => ({ getFolderPaths: () => [] }));
vi.mock("@/services/import-queue", () => {
  throw new Error("Project media must not load the import queue");
});
vi.mock("@/services/indexer", () => {
  throw new Error("Project media must not load the library indexer");
});
vi.mock("@/services/ai-embedder", () => {
  throw new Error("Project media must not load AI");
});
let runtime: TestRuntime;
let source: string;
let port: number;
let projectId: string;
let photoId: string;
let bytes: Buffer;
const PHASH_PATTERN = /^[a-f0-9]{16}$/;
const TOKEN_PATTERN = /token=[^&]+/;

function request(url: string): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}${url}`, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) })
      );
    });
    req.on("error", reject);
  });
}
function url(kind = "original", id = photoId) {
  return `/shooting-project-${kind}?projectId=${projectId}&photoId=${id}&token=${getHttpServerAuthToken()}`;
}

beforeEach(async () => {
  runtime = new TestRuntime("shooting-project-media");
  state.root = path.join(runtime.root, "profile");
  source = path.join(runtime.root, "source");
  await fs.mkdir(source);
  bytes = await sharp({
    create: { width: 80, height: 60, channels: 3, background: "#399292" },
  })
    .jpeg()
    .toBuffer();
  await fs.writeFile(path.join(source, "one.jpg"), bytes);
  startShootingProjectServices();
  const project = await createShootingProject({ sourceRoot: source });
  projectId = project.id;
  await vi.waitFor(
    async () => {
      const workspace = await getShootingProjectWorkspace(projectId);
      expect(workspace.photos[0]?.previewStatus).toBe("ready");
      photoId = workspace.photos[0].id;
      const row = getDatabase()
        .select()
        .from(shootingProjectPhotos)
        .where(eq(shootingProjectPhotos.id, photoId))
        .get();
      expect(row?.phash).toMatch(PHASH_PATTERN);
    },
    { timeout: 10_000 }
  );
  port = await startHttpServerEarly();
});
afterEach(async () => {
  await stopHttpServer();
  await stopShootingProjectServices();
  closeDatabase();
  expect(runtime.cleanup().status).toBe("deleted");
});

describe("project media for shared culling", () => {
  it("serves the exact authorized original without adding library records", async () => {
    const session = startProjectCullSession({ projectId, mode: "curate" });
    const [member] = loadProjectCullRows(session.id);
    const input = { sessionId: session.id, sessionPhotoId: member.id };
    expect(await call(getPhotoMedia, input)).toMatchObject({
      originalAvailable: true,
    });
    expect(await call(getPhotoExif, input)).toMatchObject({
      cameraModel: null,
    });
    await expect(
      call(getPhotoMedia, { ...input, sessionPhotoId: member.id + 1 })
    ).rejects.toThrow("Photo is not in this session");
    const response = await request(url());
    expect(response.status).toBe(200);
    expect(response.body).toEqual(bytes);
    expect(getDatabase().select().from(photos).all()).toHaveLength(0);
    expect((await request(`${url()}&path=outside.jpg`)).status).toBe(400);
    expect(
      (await request(url().replace(TOKEN_PATTERN, "token=invalid"))).status
    ).toBe(401);
    expect(
      (await request(url("original", "41117100-1234-4567-8901-123456789012")))
        .status
    ).toBe(404);
  });

  it("keeps offline previews and cached EXIF while refusing unavailable originals", async () => {
    expect(await readProjectExif(projectId, photoId)).toMatchObject({
      cameraModel: null,
    });
    await fs.rename(source, `${source}-offline`);
    expect(await resolveShootingProjectOriginal(projectId, photoId)).toBeNull();
    expect((await request(url())).status).toBe(404);
    expect((await request(url("preview"))).status).toBe(200);
    expect(await readProjectExif(projectId, photoId)).toMatchObject({
      cameraModel: null,
    });
  });

  it("rejects changed source bytes and never treats RAW as browser original pixels", async () => {
    await fs.writeFile(path.join(source, "one.jpg"), Buffer.from("changed"));
    expect((await request(url())).status).toBe(404);
    getDatabase()
      .update(shootingProjectPhotos)
      .set({ filename: "one.nef" })
      .where(eq(shootingProjectPhotos.id, photoId))
      .run();
    expect(await resolveShootingProjectOriginal(projectId, photoId)).toBeNull();
  });
});
