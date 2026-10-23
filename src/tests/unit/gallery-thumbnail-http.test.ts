/** @vitest-environment node */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { folders, photos } from "@/db/schema";
import {
  getHttpServerAuthToken,
  startHttpServerEarly,
  stopHttpServer,
} from "@/services/http-server";
import { thumbnailSourceIdentity } from "@/services/thumbnail-identity";
import {
  getThumbnailDir,
  initThumbnailer,
  stopThumbnailer,
} from "@/services/thumbnailer";
import { TestRuntime } from "@/tests/helpers/test-runtime";
import { invalidateFoldersCache } from "@/utils/folder-paths";

const state = vi.hoisted(() => ({ db: undefined as unknown, data: "" }));
vi.mock("@/db", () => ({ getDatabase: () => state.db }));
vi.mock("@/utils/data-path", () => ({ getDataPath: () => state.data }));
let runtime: TestRuntime;
let sqlite: Database.Database;
let port: number;
let original: string;
const previousSharpCache = sharp.cache();
function request(
  id: number,
  version?: string
): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}> {
  const query = new URLSearchParams({
    id: String(id),
    edge: "512",
    token: getHttpServerAuthToken(),
  });
  if (version) {
    query.set("rv", version);
  }
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: "127.0.0.1", port, path: `/photo-thumbnail?${query}` },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          })
        );
      }
    );
    req.on("error", reject);
  });
}
beforeAll(async () => {
  sharp.cache(false);
  runtime = new TestRuntime("gallery-http");
  state.data = path.join(runtime.root, "data");
  const images = path.join(runtime.root, "indexed");
  fs.mkdirSync(images, { recursive: true });
  original = path.join(images, "one.jpg");
  await sharp({
    create: { width: 1100, height: 550, channels: 3, background: "#2179ac" },
  })
    .jpeg()
    .toFile(original);
  sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: "drizzle" });
  state.db = db;
  db.insert(folders)
    .values({ id: 1, path: images, displayName: "indexed" })
    .run();
  db.insert(photos)
    .values([
      {
        id: 1,
        path: original,
        filename: "one.jpg",
        folderId: 1,
        width: 1100,
        height: 550,
      },
      {
        id: 2,
        path: path.join(images, "deleted.jpg"),
        filename: "deleted.jpg",
        folderId: 1,
        deletedAt: 1,
      },
      {
        id: 3,
        path: path.join(runtime.root, "unapproved.jpg"),
        filename: "unapproved.jpg",
      },
      {
        id: 4,
        path: path.join(images, "missing.jpg"),
        filename: "missing.jpg",
        folderId: 1,
      },
    ])
    .run();
  invalidateFoldersCache();
  initThumbnailer();
  port = await startHttpServerEarly();
});
afterAll(async () => {
  await stopHttpServer();
  await stopThumbnailer();
  invalidateFoldersCache();
  sqlite?.close();
  runtime?.cleanup();
  sharp.cache({
    memory: previousSharpCache.memory.max,
    files: previousSharpCache.files.max,
    items: previousSharpCache.items.max,
  });
});
describe("ID thumbnail HTTP lifecycle", () => {
  it("generates a missing thumbnail and authorizes the photo scope", async () => {
    const result = await request(1);
    expect(result.status).toBe(200);
    expect((await sharp(result.body).metadata()).width).toBe(512);
    expect(result.headers["cache-control"]).toBe("private, no-cache");
    expect((await request(2)).status).toBe(404);
    expect((await request(3)).status).toBe(403);
    expect((await request(4)).status).toBe(404);
    expect((await request(999)).status).toBe(404);
  });
  it("grants immutable caching only to the current source identity", async () => {
    const identity = thumbnailSourceIdentity(fs.statSync(original));
    expect((await request(1, identity)).headers["cache-control"]).toContain(
      "immutable"
    );
    expect((await request(1, "old-source")).headers["cache-control"]).toBe(
      "private, no-cache"
    );
  });
  it("recovers a corrupt cached variant", async () => {
    const file = fs
      .readdirSync(getThumbnailDir())
      .find((name) => name.startsWith("g-"));
    if (!file) {
      throw new Error("No generated variant to corrupt");
    }
    await fs.promises.writeFile(path.join(getThumbnailDir(), file), "corrupt");
    const result = await request(1);
    expect(result.status).toBe(200);
    expect((await sharp(result.body).metadata()).width).toBe(512);
  });
  it("serves changed sources under a new ETag without freezing the old URL", async () => {
    const identity = thumbnailSourceIdentity(fs.statSync(original));
    const previous = await request(1, identity);
    await sharp({
      create: { width: 1100, height: 550, channels: 3, background: "#b68229" },
    })
      .jpeg()
      .toFile(original);
    const changed = await request(1, identity);
    expect(changed.status).toBe(200);
    expect(changed.headers.etag).not.toBe(previous.headers.etag);
    expect(changed.headers["cache-control"]).toBe("private, no-cache");
    expect(changed.body.equals(previous.body)).toBe(false);
  });
});
