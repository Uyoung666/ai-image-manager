import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeDatabase, getDatabase } from "@/db";
import { photos } from "@/db/schema";
import {
  getHttpServerAuthToken,
  startHttpServerEarly,
  stopHttpServer,
} from "@/services/http-server";
import { initThumbnailer, stopThumbnailer } from "@/services/thumbnailer";
import { TestRuntime } from "@/tests/helpers/test-runtime";

const state = vi.hoisted(() => ({ root: "" }));
vi.mock("@/utils/data-path", () => ({ getDataPath: () => state.root }));
vi.mock("@/utils/folder-paths", () => ({ getFolderPaths: () => [] }));

function request(
  port: number,
  requestPath: string,
  headers?: Record<string, string>,
  method = "GET"
): Promise<{
  body: Buffer;
  headers: http.IncomingHttpHeaders;
  status: number;
}> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", method, path: requestPath, port, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            body: Buffer.concat(chunks),
            headers: res.headers,
            status: res.statusCode ?? 0,
          })
        );
      }
    );
    req.on("error", reject);
    req.end();
  });
}

describe("HTTP media server security", () => {
  let port: number;
  let runtime: TestRuntime;
  let image: string;
  let imageBytes: Buffer;

  beforeAll(async () => {
    runtime = new TestRuntime("http-security");
    state.root = runtime.root;
    initThumbnailer();
    image = path.join(runtime.root, "authorized.png");
    imageBytes = await sharp({
      create: { width: 4, height: 6, channels: 3, background: "#2179ac" },
    })
      .png()
      .toBuffer();
    await fs.promises.writeFile(image, imageBytes);
    port = await startHttpServerEarly();
  });

  afterAll(async () => {
    await stopHttpServer();
    await stopThumbnailer();
    closeDatabase();
    runtime?.cleanup();
  });

  it("requires the per-process media token", async () => {
    const response = await request(port, "/image?path=%2Foutside.jpg", {
      origin: "https://evil.example",
    });
    expect(response.status).toBe(401);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("validates project media IDs before resolving any filesystem path", async () => {
    const token = getHttpServerAuthToken();
    expect(
      (
        await request(
          port,
          `/shooting-project-preview?projectId=../../&photoId=1&token=${token}`
        )
      ).status
    ).toBe(400);
    expect(
      (await request(port, "/shooting-project-preview?projectId=1&photoId=1"))
        .status
    ).toBe(401);
    const uuid = "b4b7db0d-825a-460d-a4c0-c38c10f9028d";
    expect(
      (
        await request(
          port,
          `/shooting-project-preview?projectId=${uuid}&photoId=${uuid}&path=${encodeURIComponent(image)}&token=${token}`
        )
      ).status
    ).toBe(400);
  });

  it("grants an explicit active library photo access without exposing its siblings", async () => {
    const external = new TestRuntime("http-explicit-file");
    const directory = path.join(external.root, "outside-library");
    await fs.promises.mkdir(directory);
    const allowed = path.join(directory, "selected.png");
    const sibling = path.join(directory, "unselected.png");
    await fs.promises.writeFile(allowed, imageBytes);
    await fs.promises.writeFile(sibling, imageBytes);
    getDatabase()
      .insert(photos)
      .values({ path: allowed, filename: "selected.png" })
      .run();
    const token = getHttpServerAuthToken();
    try {
      const explicit = getDatabase()
        .select()
        .from(photos)
        .all()
        .find((photo) => photo.path === allowed);
      expect(explicit).toBeDefined();
      const thumbnail = await request(
        port,
        `/photo-thumbnail?id=${explicit?.id}&edge=512&token=${token}`
      );
      expect(thumbnail.status).toBe(200);
      expect(thumbnail.headers["content-type"]).toBe("image/webp");
      expect(
        (
          await request(
            port,
            `/image?path=${encodeURIComponent(allowed)}&token=${token}`
          )
        ).status
      ).toBe(200);
      expect(
        (
          await request(
            port,
            `/image?path=${encodeURIComponent(sibling)}&token=${token}`
          )
        ).status
      ).toBe(403);
    } finally {
      external.cleanup();
    }
  });

  it("rejects a multibyte token without interrupting subsequent authorized image requests", async () => {
    const token = getHttpServerAuthToken();
    const invalidToken = "中".repeat(token.length);
    const imagePath = encodeURIComponent(image);
    const rejected = await request(
      port,
      `/image?path=${imagePath}&token=${encodeURIComponent(invalidToken)}`
    );
    expect(rejected.status).toBe(401);
    const authorized = await request(
      port,
      `/image?path=${imagePath}&token=${encodeURIComponent(token)}`
    );
    expect(authorized.status).toBe(200);
    expect(authorized.headers["content-type"]).toBe("image/png");
    expect(authorized.body.equals(imageBytes)).toBe(true);
  });

  it("protects ID thumbnails and rejects unrestricted sizes before reading the database", async () => {
    expect((await request(port, "/photo-thumbnail?id=1&edge=512")).status).toBe(
      401
    );
    const token = encodeURIComponent(getHttpServerAuthToken());
    expect(
      (await request(port, `/photo-thumbnail?id=1&edge=513&token=${token}`))
        .status
    ).toBe(400);
    expect(
      (await request(port, `/photo-thumbnail?id=-1&edge=512&token=${token}`))
        .status
    ).toBe(400);
  });

  it("does not grant wildcard CORS even with a valid token", async () => {
    const token = encodeURIComponent(getHttpServerAuthToken());
    const response = await request(
      port,
      `/image?token=${token}`,
      { origin: "https://evil.example" },
      "OPTIONS"
    );
    expect(response.status).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
