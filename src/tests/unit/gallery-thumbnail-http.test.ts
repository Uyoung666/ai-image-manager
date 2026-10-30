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
  generateGalleryThumbnail,
  generateThumbnail,
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
  version?: string,
  etag?: string,
  edge = 512,
  selectAvailable = false,
  repair = false
): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}> {
  const query = new URLSearchParams({
    id: String(id),
    edge: String(edge),
    token: getHttpServerAuthToken(),
  });
  if (version) {
    query.set("rv", version);
  }
  if (selectAvailable) {
    query.set("select", "1");
  }
  if (repair) {
    query.set("repair", "1");
  }
  return new Promise((resolve, reject) => {
    const req = http.get(
      {
        host: "127.0.0.1",
        port,
        path: `/photo-thumbnail?${query}`,
        headers: etag ? { "if-none-match": etag } : {},
      },
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
async function damagePixels(file: string): Promise<void> {
  const bytes = await fs.promises.readFile(file);
  const chunk = bytes.indexOf(Buffer.from("VP8 "));
  expect(chunk).toBeGreaterThanOrEqual(0);
  bytes.fill(255, chunk + 18, chunk + 8 + bytes.readUInt32LE(chunk + 4));
  await fs.promises.writeFile(file, bytes);
  expect((await sharp(file).metadata()).width).toBeGreaterThan(0);
  await expect(sharp(file).raw().toBuffer()).rejects.toThrow();
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
        path: path.join(runtime.root, "explicit-missing.jpg"),
        filename: "explicit-missing.jpg",
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
  it("selects an adequate preview without a second HTTP request, then prefers a prepared exact tier", async () => {
    await generateThumbnail(original, "md");
    const selected = await request(1, undefined, undefined, 256, true);
    expect(selected.status).toBe(200);
    expect((await sharp(selected.body).metadata()).width).toBe(1024);
    expect(selected.headers["cache-control"]).toBe(
      "private, max-age=1, must-revalidate"
    );
    expect((await request(2, undefined, undefined, 256, true)).status).toBe(
      404
    );
    expect((await request(3, undefined, undefined, 256, true)).status).toBe(
      404
    );
    await request(1, undefined, undefined, 256);
    const exact = await request(1, undefined, undefined, 256, true);
    expect((await sharp(exact.body).metadata()).width).toBe(256);
    const identity = thumbnailSourceIdentity(fs.statSync(original));
    expect(
      (await request(1, identity, undefined, 256, true)).headers[
        "cache-control"
      ]
    ).toBe("private, max-age=1, must-revalidate");
  });
  it("serves the physical small edge and validates an unchanged response", async () => {
    const preview = await generateThumbnail(original, "md");
    const first = await request(
      1,
      thumbnailSourceIdentity(fs.statSync(original)),
      undefined,
      256
    );
    expect((await sharp(first.body).metadata()).width).toBe(256);
    expect(first.headers.etag).not.toContain(
      path.basename(preview.thumbnailPath)
    );
    expect((await request(1, undefined, first.headers.etag, 256)).status).toBe(
      304
    );
  });
  it("generates a missing thumbnail and authorizes the photo scope", async () => {
    const result = await request(1);
    expect(result.status).toBe(200);
    expect((await sharp(result.body).metadata()).width).toBe(512);
    expect(result.headers["cache-control"]).toBe("private, no-cache");
    expect((await request(2)).status).toBe(404);
    expect((await request(3)).status).toBe(404);
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
      .find((name) => name.startsWith("g-") && name.endsWith("-512.webp"));
    if (!file) {
      throw new Error("No generated variant to corrupt");
    }
    await fs.promises.writeFile(path.join(getThumbnailDir(), file), "corrupt");
    const result = await request(1);
    expect(result.status).toBe(200);
    expect((await sharp(result.body).metadata()).width).toBe(512);
  });
  it("repairs pixel-damaged exact variants without immutable caching and keeps authorization checks", async () => {
    const variant = await generateGalleryThumbnail(original, 256);
    await damagePixels(variant.thumbnailPath);
    const identity = thumbnailSourceIdentity(fs.statSync(original));
    const damaged = await request(1, identity, undefined, 256);
    await expect(sharp(damaged.body).raw().toBuffer()).rejects.toThrow();
    const repaired = await request(
      1,
      identity,
      damaged.headers.etag,
      256,
      false,
      true
    );
    expect(repaired.status).toBe(200);
    expect(repaired.headers["cache-control"]).toBe("private, no-cache");
    expect(repaired.headers.etag).not.toBe(damaged.headers.etag);
    await expect(sharp(repaired.body).raw().toBuffer()).resolves.toBeInstanceOf(
      Buffer
    );
    expect(
      (await request(2, undefined, undefined, 256, false, true)).status
    ).toBe(404);
    expect(
      (await request(3, undefined, undefined, 256, false, true)).status
    ).toBe(404);
  });
  it("repairs a pixel-damaged legacy preview even when it exactly matches the requested edge", async () => {
    const file = path.join(path.dirname(original), "repair-exact.jpg");
    await sharp({
      create: { width: 512, height: 256, channels: 3, background: "#2179ac" },
    })
      .jpeg()
      .toFile(file);
    drizzle(sqlite)
      .insert(photos)
      .values({
        id: 6,
        path: file,
        filename: "repair-exact.jpg",
        folderId: 1,
        width: 512,
        height: 256,
      })
      .run();
    const preview = await generateThumbnail(file, "md");
    await damagePixels(preview.thumbnailPath);
    const selected = await request(6, undefined, undefined, 512, true);
    await expect(sharp(selected.body).raw().toBuffer()).rejects.toThrow();
    const repaired = await request(
      6,
      undefined,
      selected.headers.etag,
      512,
      false,
      true
    );
    expect(repaired.status).toBe(200);
    expect((await sharp(repaired.body).metadata()).width).toBe(512);
    await expect(sharp(repaired.body).raw().toBuffer()).resolves.toBeInstanceOf(
      Buffer
    );
    const next = await request(6, undefined, undefined, 512, true);
    expect(next.body.equals(repaired.body)).toBe(true);
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
  it("changes ETag when an exact legacy preview is rebuilt at the same path", async () => {
    const file = path.join(path.dirname(original), "exact.jpg");
    const writeSource = async (background: string) =>
      sharp({ create: { width: 512, height: 256, channels: 3, background } })
        .jpeg()
        .toFile(file);
    await writeSource("#2179ac");
    drizzle(sqlite)
      .insert(photos)
      .values({
        id: 5,
        path: file,
        filename: "exact.jpg",
        folderId: 1,
        width: 512,
        height: 256,
      })
      .run();
    const identity = thumbnailSourceIdentity(fs.statSync(file));
    const preview = await generateThumbnail(file, "md");
    const first = await request(5, identity);
    expect(first.headers.etag).toContain(path.basename(preview.thumbnailPath));
    expect((await request(5, identity, first.headers.etag)).status).toBe(304);
    await writeSource("#b68229");
    await generateThumbnail(file, "md");
    const next = await request(5, identity, first.headers.etag);
    expect(next.status).toBe(200);
    expect(next.headers.etag).not.toBe(first.headers.etag);
    expect(next.body.equals(first.body)).toBe(false);
  });
});
