/** @vitest-environment node */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  getHttpServerAuthToken,
  isHttpServerRunning,
  startHttpServerEarly,
  stopHttpServer,
} from "@/services/http-server";
import { TestRuntime } from "@/tests/helpers/test-runtime";

const state = vi.hoisted(() => ({ root: "" }));
vi.mock("@/utils/data-path", () => ({ getDataPath: () => state.root }));
vi.mock("@/utils/folder-paths", () => ({ getFolderPaths: () => [] }));

it("does not resolve shutdown before the media file descriptors close", async () => {
  const runtime = new TestRuntime("http-shutdown");
  state.root = runtime.root;
  const image = path.join(runtime.root, "image.png");
  fs.copyFileSync("assets/icons/icon-64.png", image);
  const streams: fs.ReadStream[] = [];
  const open = fs.createReadStream.bind(fs);
  const spy = vi.spyOn(fs, "createReadStream").mockImplementation((...args) => {
    const stream = open(...args);
    streams.push(stream);
    return stream;
  });
  let request: http.ClientRequest | undefined;
  try {
    const port = await startHttpServerEarly();
    const query = new URLSearchParams({
      path: image,
      token: getHttpServerAuthToken(),
    });
    await new Promise<void>((resolve, reject) => {
      request = http.get(
        `http://127.0.0.1:${port}/image?${query}`,
        (response) => {
          response.resume();
          response.once("end", resolve);
          response.once("error", reject);
        }
      );
      request.once("error", reject);
    });
    await stopHttpServer();
    expect(streams.length).toBeGreaterThan(0);
    expect(streams.every((stream) => stream.closed)).toBe(true);
  } finally {
    request?.destroy();
    await stopHttpServer();
    spy.mockRestore();
    expect(runtime.cleanup().status).toBe("deleted");
  }
});

it("closes in-flight media connections before waiting for the HTTP server to stop", async () => {
  const createServer = http.createServer.bind(http);
  const heldServer = createServer((_request, response) => {
    response.writeHead(200);
    response.write("pending media response");
    // The renderer still owns this response while app.quit awaits cleanup.
  });
  const create = vi.spyOn(http, "createServer").mockReturnValue(heldServer);
  let request: http.ClientRequest | undefined;
  try {
    const port = await startHttpServerEarly();
    await new Promise<void>((resolve, reject) => {
      request = http.get(`http://127.0.0.1:${port}/held-media`, (response) => {
        response.once("data", () => resolve());
        response.on("error", () => undefined);
      });
      request.once("error", reject);
    });
    let stopped = false;
    const stopping = stopHttpServer().then(() => {
      stopped = true;
    });
    try {
      await expect.poll(() => stopped, { timeout: 2000 }).toBe(true);
      await stopping;
      expect(isHttpServerRunning()).toBe(false);
    } finally {
      heldServer.closeAllConnections();
      await stopping;
    }
  } finally {
    request?.destroy();
    create.mockRestore();
    await stopHttpServer();
  }
});
