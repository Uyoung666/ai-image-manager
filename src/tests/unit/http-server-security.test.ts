import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  getHttpServerAuthToken,
  startHttpServerEarly,
  stopHttpServer,
} from "@/services/http-server";

function request(
  port: number,
  requestPath: string,
  headers?: Record<string, string>,
  method = "GET"
): Promise<{ headers: http.IncomingHttpHeaders; status: number }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", method, path: requestPath, port, headers },
      (res) => {
        res.resume();
        res.on("end", () =>
          resolve({ headers: res.headers, status: res.statusCode ?? 0 })
        );
      }
    );
    req.on("error", reject);
    req.end();
  });
}

describe("HTTP media server security", () => {
  let port: number;

  beforeAll(async () => {
    port = await startHttpServerEarly();
  });

  afterAll(async () => {
    await stopHttpServer();
  });

  it("requires the per-process media token", async () => {
    const response = await request(port, "/image?path=%2Foutside.jpg", {
      origin: "https://evil.example",
    });
    expect(response.status).toBe(401);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
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
