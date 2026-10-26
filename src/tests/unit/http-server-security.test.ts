import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  getHttpServerAuthToken,
  startHttpServerEarly,
  stopHttpServer,
} from "@/services/http-server";
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
    runtime?.cleanup();
  });

  it("requires the per-process media token", async () => {
    const response = await request(port, "/image?path=%2Foutside.jpg", {
      origin: "https://evil.example",
    });
    expect(response.status).toBe(401);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
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
