import { createReadStream } from "node:fs";
import fsp from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";

const FEED_FILE_PATTERN = /^(?:RELEASES|[A-Za-z0-9._-]+\.nupkg)$/;

export async function startLocalFeed(directory) {
  const root = await fsp.realpath(directory);
  const server = createServer(async (request, response) => {
    try {
      if (!["GET", "HEAD"].includes(request.method)) {
        response.writeHead(405).end();
        return;
      }
      const name = decodeURIComponent(
        new URL(request.url, "http://127.0.0.1").pathname
      ).slice(1);
      // Serve only flat Squirrel feed files, never arbitrary runner paths.
      if (!FEED_FILE_PATTERN.test(name)) {
        response.writeHead(404).end();
        return;
      }
      const file = await fsp.realpath(path.join(root, name));
      if (path.dirname(file) !== root) {
        throw new Error("Feed path escaped its root");
      }
      const stat = await fsp.stat(file);
      if (!stat.isFile()) {
        throw new Error("Not a file");
      }
      response.writeHead(200, {
        "Content-Length": stat.size,
        "Cache-Control": "no-store",
      });
      if (request.method === "HEAD") {
        response.end();
        return;
      }
      const body = createReadStream(file);
      response.once("close", () => body.destroy());
      body.once("error", () => response.destroy());
      body.pipe(response);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}
