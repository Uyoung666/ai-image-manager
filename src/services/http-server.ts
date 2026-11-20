import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { and, eq, isNull, sql } from "drizzle-orm";
import sharp from "sharp";
import { getDatabase } from "@/db";
import { photos } from "@/db/schema";
import { needsNativePlayback } from "@/services/browser-image-animation";
import {
  applyExifOrientation,
  resolveImageOrientation,
} from "@/services/image-orientation";
import { extractRawPreview, isRawFile } from "@/services/raw-preview";
import {
  readValidatedThumbnail,
  validateThumbnail,
} from "@/services/thumbnail-validation";
import {
  findPhotoPathByDuelPreview,
  findPhotoPathByThumbnail,
  generateDuelPreview,
  generateGalleryThumbnail,
  generateThumbnail,
} from "@/services/thumbnailer";
import { getDataPath } from "@/utils/data-path";
import { getFolderPaths } from "@/utils/folder-paths";
import {
  BROWSE_PREVIEW_EDGES,
  type BrowsePreviewEdge,
  GALLERY_CONFIG,
  GALLERY_THUMBNAIL_EDGES,
} from "@/utils/gallery-config";
import { recordGalleryMediaStat } from "@/utils/gallery-perf";
import { createLogger } from "@/utils/logger";
import { resolveSafePath as resolveSecurePath } from "@/utils/path-security";
import { decodeHeifDisplay } from "./heif-input";

const log = createLogger("http-server");
const PROJECT_MEDIA_ID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

// ── 服务器实例与状态 ──────────────────────────────────────────────────

let server: http.Server | null = null;
let serverPort: number | null = null;
let isServerStarted = false;
const authToken = randomBytes(32).toString("hex");
// 保存首次分配的端口号，重启时复用，避免 renderer 持有的
// preload 注入端口（通过 --http-port）在迁移后失效。
let lastUsedPort: number | null = null;
const mediaStreams = new Map<fs.ReadStream, Promise<void>>();

function openMediaStream(filePath: string): fs.ReadStream {
  const stream = fs.createReadStream(filePath);
  const closed = new Promise<void>((resolve) => {
    stream.once("close", () => {
      mediaStreams.delete(stream);
      resolve();
    });
  });
  mediaStreams.set(stream, closed);
  return stream;
}

// ── MIME 类型映射 ─────────────────────────────────────────────────────

const MIME_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".cr2": "image/x-canon-cr2",
  ".cr3": "image/x-canon-cr3",
  ".nef": "image/x-nikon-nef",
  ".nrw": "image/x-nikon-nrw",
  ".arw": "image/x-sony-arw",
  ".srf": "image/x-sony-srf",
  ".sr2": "image/x-sony-sr2",
  ".dng": "image/x-adobe-dng",
  ".orf": "image/x-olympus-orf",
  ".rw2": "image/x-panasonic-rw2",
  ".raf": "image/x-fujifilm-raf",
  ".pef": "image/x-pentax-pef",
  ".rwl": "image/x-leica-rwl",
  ".3fr": "image/x-hasselblad-3fr",
  ".raw": "image/x-raw",
  ".tiff": "image/tiff",
  ".tif": "image/tiff",
  ".heic": "image/heic",
  ".heif": "image/heif",
};

function getMimeType(ext: string): string {
  return MIME_TYPES[ext] ?? "image/png";
}

// ── 浏览器原生支持的图片格式 ──────────────────────────────────────────

const BROWSER_COMPATIBLE = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".bmp",
  ".ico",
  ".avif",
  ".svg",
]);

function isBrowserCompatible(ext: string): boolean {
  return BROWSER_COMPATIBLE.has(ext);
}

// ── Sharp 转换并发控制 ────────────────────────────────────────────────

class ConversionSemaphore {
  private running = 0;
  private readonly pending: Array<() => void> = [];
  private readonly max: number;

  constructor(max: number) {
    this.max = max;
  }

  acquire(): Promise<void> {
    if (this.running < this.max) {
      this.running++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.pending.push(resolve);
    });
  }

  release(): void {
    this.running--;
    const next = this.pending.shift();
    if (next) {
      this.running++;
      next();
    }
  }

  get active(): number {
    return this.running;
  }

  get queued(): number {
    return this.pending.length;
  }
}

const conversionSemaphore = new ConversionSemaphore(4);

async function createOrientedPipeline(
  input: string,
  originalPath: string
): Promise<ReturnType<typeof sharp>> {
  const metadata = await sharp(input, { failOn: "none" }).metadata();
  const orientation = await resolveImageOrientation(originalPath, metadata);
  return applyExifOrientation(sharp(input, { failOn: "none" }), orientation);
}

async function normalizeJpegPreview(
  preview: Buffer,
  originalPath: string
): Promise<Buffer> {
  const metadata = await sharp(preview, { failOn: "none" }).metadata();
  const orientation = await resolveImageOrientation(originalPath, metadata);
  if (orientation === 1) {
    return preview;
  }
  return await applyExifOrientation(
    sharp(preview, { failOn: "none" }),
    orientation
  )
    .jpeg({ quality: 95 })
    .toBuffer();
}

async function serveOrientedBrowserFile(
  safePath: string,
  ext: string,
  res: http.ServerResponse
): Promise<boolean> {
  let pipeline: ReturnType<typeof sharp>;
  try {
    const input = await fs.promises.readFile(safePath);
    const metadata = await sharp(input, { failOn: "none" }).metadata();
    const orientation = await resolveImageOrientation(safePath, metadata);
    if (orientation === 1) {
      return false;
    }
    pipeline = applyExifOrientation(
      sharp(input, { failOn: "none" }),
      orientation
    );
  } catch {
    return false;
  }

  const isJpeg = ext === ".jpg" || ext === ".jpeg";
  const output = isJpeg
    ? await pipeline.jpeg({ quality: 95 }).toBuffer()
    : await pipeline.png().toBuffer();
  res.setHeader("content-type", isJpeg ? "image/jpeg" : "image/png");
  res.setHeader("cache-control", "private, no-cache");
  res.setHeader("content-length", output.length);
  res.writeHead(200);
  res.end(output);
  return true;
}

// ── 安全关闭响应 ──────────────────────────────────────────────────────

function safeEndError(
  res: http.ServerResponse,
  status: number,
  body: string
): void {
  if (res.destroyed) {
    return;
  }
  if (res.headersSent) {
    res.destroy();
  } else {
    res.writeHead(status);
    res.end(body);
  }
}

// ── CORS 响应头 ───────────────────────────────────────────────────────

function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin || origin === "null") {
    return origin === "null";
  }
  try {
    const parsed = new URL(origin);
    return (
      parsed.protocol === "http:" &&
      (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")
    );
  } catch {
    return false;
  }
}

function setCorsHeaders(res: http.ServerResponse, origin?: string): void {
  if (typeof origin !== "string" || !isAllowedOrigin(origin)) {
    return;
  }
  res.setHeader("access-control-allow-origin", origin);
  res.setHeader("vary", "Origin");
}

function isValidAuthToken(candidate: string | undefined): boolean {
  if (!candidate) {
    return false;
  }
  const actual = Buffer.from(candidate);
  const expected = Buffer.from(authToken);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function isAuthorized(
  req: http.IncomingMessage,
  searchParams: URLSearchParams
): boolean {
  const queryToken = searchParams.get("token") ?? undefined;
  const headerToken = req.headers["x-ai-image-manager-token"];
  const candidate =
    queryToken ?? (typeof headerToken === "string" ? headerToken : undefined);
  return isValidAuthToken(candidate);
}

// ── 路径安全校验 ──────────────────────────────────────────────────────

function resolveSafePath(
  targetPath: string,
  allowExplicitPhoto = false
): string | null {
  const allowedRoots = [getDataPath(), ...getFolderPaths()];
  const managed = resolveSecurePath(targetPath, allowedRoots);
  if (managed || !allowExplicitPhoto) {
    return managed;
  }
  // An explicitly imported file grants access to that one active photo. Its
  // containing directory remains outside the managed library/watch scope.
  const photo = getDatabase()
    .select({ path: photos.path })
    .from(photos)
    .where(
      and(eq(photos.path, path.resolve(targetPath)), isNull(photos.deletedAt))
    )
    .get();
  return photo ? resolveSecurePath(targetPath, [photo.path]) : null;
}

// ── 路由：GET /thumbnail ──────────────────────────────────────────────
// 三阶段处理：
//   Phase A — 文件存在且有效 → 直接流式返回
//   Phase B — 文件缺失 (ENOENT) 或损坏 → 按需重新生成后返回
// 重试按钮（前端 ?retry=N 参数）和缓存淘汰后均自动恢复。

function serveStaticFile(
  filePath: string,
  res: http.ServerResponse,
  mimeType: string,
  immutable: boolean,
  knownStats?: fs.Stats
): void {
  (knownStats ? Promise.resolve(knownStats) : fs.promises.stat(filePath))
    .then((stats) => {
      if (res.destroyed || res.writableEnded) {
        return;
      }
      if (!stats.isFile()) {
        res.writeHead(404);
        res.end("Not a file");
        return;
      }

      res.setHeader("content-type", mimeType);
      if (!res.hasHeader("cache-control")) {
        res.setHeader(
          "cache-control",
          immutable
            ? "public, max-age=31536000, immutable"
            : "public, max-age=86400"
        );
      }
      res.setHeader("content-length", stats.size);
      res.writeHead(200);

      const readStream = openMediaStream(filePath);
      const started = performance.now();
      readStream.once("end", () =>
        recordGalleryMediaStat("mediaStreamReadMs", performance.now() - started)
      );
      res.once("close", () => readStream.destroy());
      readStream.on("error", (err) => {
        if (res.headersSent) {
          res.destroy();
        } else {
          res.writeHead(500);
          res.end("Internal Server Error");
        }
        log.warn(
          `[HttpServer] stream error for ${filePath}: ${(err as Error)?.message ?? String(err)}`
        );
      });
      readStream.pipe(res);
    })
    .catch((err: NodeJS.ErrnoException) => {
      if (!res.headersSent) {
        const code = err?.code;
        if (code === "ENOENT") {
          res.writeHead(404);
          res.end("Not Found");
        } else {
          res.writeHead(500);
          res.end("Internal Server Error");
        }
        log.warn(
          `[HttpServer] stat error for ${filePath}: ${(err as Error)?.message ?? String(err)}`
        );
      }
    });
}

// ── 按需重新生成辅助函数 ────────────────────────────────────────────────

async function regenerateAndServeThumbnail(
  safePath: string,
  res: http.ServerResponse
): Promise<void> {
  recordGalleryMediaStat("thumbnailRegenerate");
  try {
    const lookup = findPhotoPathByThumbnail(safePath);
    if (!lookup) {
      if (!res.headersSent) {
        res.writeHead(404);
        res.end("Not Found");
      }
      log.warn(
        `[HttpServer] /thumbnail orphaned, no original photo: ${safePath}`
      );
      return;
    }

    log.info(
      `[HttpServer] /thumbnail regenerating: ${path.basename(safePath)} → ${lookup.photoPath} (${lookup.size})`
    );

    const result = await generateThumbnail(lookup.photoPath, lookup.size);
    res.setHeader("cache-control", "private, no-cache");
    serveStaticFile(result.thumbnailPath, res, "image/webp", false);
  } catch (regenerateErr) {
    if (!res.headersSent) {
      res.writeHead(500);
      res.end("Thumbnail regeneration failed");
    }
    log.warn(
      `[HttpServer] /thumbnail regeneration failed for ${safePath}: ${(regenerateErr as Error)?.message ?? String(regenerateErr)}`
    );
  }
}

async function regenerateAndServeDuelPreview(
  safePath: string,
  res: http.ServerResponse
): Promise<void> {
  try {
    const photoPath = findPhotoPathByDuelPreview(safePath);
    if (!photoPath) {
      if (!res.headersSent) {
        res.writeHead(404);
        res.end("Not Found");
      }
      log.warn(
        `[HttpServer] /duel-preview orphaned, no original photo: ${safePath}`
      );
      return;
    }

    log.info(
      `[HttpServer] /duel-preview regenerating: ${path.basename(safePath)} → ${photoPath}`
    );

    const result = await generateDuelPreview(photoPath);
    if (!result) {
      if (!res.headersSent) {
        res.writeHead(500);
        res.end("Duel preview generation returned null");
      }
      return;
    }

    res.setHeader("cache-control", "private, no-cache");
    serveStaticFile(result.previewPath, res, "image/jpeg", false);
  } catch (regenerateErr) {
    if (!res.headersSent) {
      res.writeHead(500);
      res.end("Duel preview regeneration failed");
    }
    log.warn(
      `[HttpServer] /duel-preview regeneration failed for ${safePath}: ${(regenerateErr as Error)?.message ?? String(regenerateErr)}`
    );
  }
}

async function handleThumbnail(
  safePath: string,
  res: http.ServerResponse
): Promise<void> {
  setCorsHeaders(res);
  res.setHeader("cache-control", "private, no-cache");
  recordGalleryMediaStat("thumbnailRequest");

  // Phase A: Try to serve existing file (with integrity validation)
  let stats: fs.Stats;
  try {
    stats = await fs.promises.stat(safePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      if (!res.headersSent) {
        res.writeHead(500);
        res.end("Internal Server Error");
      }
      return;
    }
    // File not found → Phase B
    stats = null as unknown as fs.Stats;
  }

  if (stats?.isFile()) {
    // Validate integrity: sharp.metadata() on a corrupt file will throw
    try {
      await validateThumbnail(safePath, stats);
    } catch {
      // Corrupt file → delete and fall through to regeneration
      log.warn(`[HttpServer] /thumbnail corrupt file, deleting: ${safePath}`);
      await fs.promises.unlink(safePath).catch(() => {
        /* best-effort deletion */
      });
      stats = null as unknown as fs.Stats; // trigger Phase B
    }
  }

  if (stats?.isFile()) {
    // Valid file → serve
    recordGalleryMediaStat("thumbnailHit");
    const diskExt = path.extname(safePath).toLowerCase();
    serveStaticFile(safePath, res, getMimeType(diskExt), true, stats);
    return;
  }

  // Phase B: On-demand regeneration
  await regenerateAndServeThumbnail(safePath, res);
}

/** /duel-preview 路由 — 预生成的 2560px JPEG 对比预览（PK 选片专用）。
 *  文件缺失或损坏时自动触发重新生成。 */
async function handleDuelPreview(
  safePath: string,
  res: http.ServerResponse
): Promise<void> {
  setCorsHeaders(res);
  res.setHeader("cache-control", "private, no-cache");

  // Phase A: Try to serve existing file (with integrity validation)
  let stats: fs.Stats;
  try {
    stats = await fs.promises.stat(safePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    if (code === "ENOENT") {
      stats = null as unknown as fs.Stats; // Phase B
    } else {
      res.writeHead(500);
      res.end("Internal Server Error");
      return;
    }
  }

  if (stats?.isFile()) {
    try {
      await sharp(safePath).metadata();
    } catch {
      log.warn(
        `[HttpServer] /duel-preview corrupt file, deleting: ${safePath}`
      );
      await fs.promises.unlink(safePath).catch(() => {
        /* best-effort deletion */
      });
      stats = null as unknown as fs.Stats;
    }
  }

  if (stats?.isFile()) {
    serveStaticFile(safePath, res, "image/jpeg", true);
    return;
  }

  // Phase B: On-demand regeneration
  await regenerateAndServeDuelPreview(safePath, res);
}

// ── 路由：GET /preview ────────────────────────────────────────────────

async function handlePreview(
  safePath: string,
  res: http.ServerResponse
): Promise<void> {
  setCorsHeaders(res);

  const ext = path.extname(safePath).toLowerCase();

  if (!isRawFile(safePath)) {
    log.warn(
      `[HttpServer] /preview rejected: not a RAW file — ext=${ext} path=${safePath}`
    );
    res.writeHead(404);
    res.end("Not a RAW file");
    return;
  }

  let stats: fs.Stats;
  try {
    stats = await fs.promises.stat(safePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    log.error(
      `[HttpServer] /preview stat failed: path=${safePath} code=${code} message=${(err as Error).message}`
    );
    if (!res.headersSent) {
      res.writeHead(code === "ENOENT" ? 404 : 500);
      res.end(code === "ENOENT" ? "Not Found" : "Internal Server Error");
    }
    return;
  }

  if (!stats.isFile()) {
    log.warn(
      `[HttpServer] /preview rejected: path is not a file — path=${safePath}`
    );
    res.writeHead(404);
    res.end("Not a file");
    return;
  }

  log.info(
    `[HttpServer] /preview extracting: path=${safePath} size=${stats.size} ext=${ext}`
  );

  let preview: Buffer | null = null;
  const extractStart = Date.now();

  try {
    preview = await extractRawPreview(safePath);
  } catch (err) {
    log.error(
      `[HttpServer] /preview extractRawPreview THREW: path=${safePath} error=${(err as Error).message} stack=${(err as Error).stack}`
    );
    if (!res.headersSent) {
      res.writeHead(500);
      res.end("Preview extraction failed");
    }
    return;
  }

  const extractMs = Date.now() - extractStart;

  if (!preview) {
    log.warn(
      `[HttpServer] /preview returned null — all 4 extraction stages failed. path=${safePath} ext=${ext} size=${stats.size} elapsed=${extractMs}ms`
    );
    res.writeHead(404);
    res.end("No embedded preview available");
    return;
  }

  if (preview.length === 0) {
    log.error(
      `[HttpServer] /preview returned EMPTY buffer — length=0. path=${safePath} elapsed=${extractMs}ms`
    );
    res.writeHead(404);
    res.end("No embedded preview available");
    return;
  }

  log.info(
    `[HttpServer] /preview OK: path=${safePath} size=${preview.length} bytes elapsed=${extractMs}ms`
  );

  preview = await normalizeJpegPreview(preview, safePath);

  res.setHeader("content-type", "image/jpeg");
  res.setHeader("cache-control", "private, no-cache");
  res.setHeader("content-length", preview.length);
  res.writeHead(200);
  res.end(preview);
}

// ── 路由：GET /image ──────────────────────────────────────────────────
// RAW → extractRawPreview (不走 sharp)，browser-compatible → 直接流式，
// HEIC/TIFF 等 → sharp({failOn:"none"}).png().pipe(res) 并发上限 4。

function handleImage(safePath: string, res: http.ServerResponse): void {
  setCorsHeaders(res);

  fs.promises
    .stat(safePath)
    .then(async (stats) => {
      if (!stats.isFile()) {
        res.writeHead(404);
        res.end("Not a file");
        return;
      }

      const ext = path.extname(safePath).toLowerCase();

      // ── 路径 1：RAW 格式 → extractRawPreview 提取内嵌 JPEG ──
      // 旧 local-media:// 协议从未将 RAW 传给 sharp。
      // Sharp 的预编译 libvips 不含专有 RAW 解码器（CR2/NEF 等），
      // 强行传入会导致 "compression method is not configured" 致命错误。
      if (isRawFile(safePath)) {
        log.info(
          `[HttpServer] /image RAW → extractRawPreview: path=${safePath} ext=${ext}`
        );

        const extractStart = Date.now();
        let preview: Buffer | null = null;

        try {
          preview = await extractRawPreview(safePath);
        } catch (err) {
          log.error(
            `[HttpServer] /image extractRawPreview THREW: path=${safePath} error=${(err as Error).message}`
          );
          safeEndError(res, 500, "Preview extraction failed");
          return;
        }

        if (!preview || preview.length === 0) {
          log.error(
            `[HttpServer] /image extractRawPreview failed: path=${safePath} elapsed=${Date.now() - extractStart}ms`
          );
          safeEndError(res, 500, "No embedded preview available");
          return;
        }

        log.info(
          `[HttpServer] /image RAW preview OK: path=${safePath} size=${preview.length} bytes elapsed=${Date.now() - extractStart}ms`
        );

        preview = await normalizeJpegPreview(preview, safePath);

        res.setHeader("content-type", "image/jpeg");
        res.setHeader("cache-control", "private, no-cache");
        res.setHeader("content-length", preview.length);
        res.writeHead(200);
        res.end(preview);
        return;
      }

      // ── 路径 2：浏览器原生兼容 → 直接流式输出 ──────────────
      if (isBrowserCompatible(ext)) {
        if (await serveOrientedBrowserFile(safePath, ext, res)) {
          return;
        }

        const mimeType = getMimeType(ext);
        res.setHeader("content-type", mimeType);
        res.setHeader("cache-control", "private, no-cache");
        res.setHeader("content-length", stats.size);
        res.writeHead(200);

        const readStream = openMediaStream(safePath);
        res.once("close", () => readStream.destroy());

        readStream.on("error", (err) => {
          if (res.headersSent) {
            res.destroy();
          } else {
            res.writeHead(500);
            res.end("Internal Server Error");
          }
          log.warn(
            `[HttpServer] /image static stream error for ${safePath}: ${(err as Error)?.message ?? String(err)}`
          );
        });

        readStream.pipe(res);
        return;
      }

      // ── 路径 3：其他需转换格式 (HEIC/TIFF/…) → sharp 流式转换 ──
      // 受并发信号量保护，上限 4 个同时转换。
      log.info(
        `[HttpServer] /image converting via sharp: path=${safePath} ext=${ext} size=${stats.size}`
      );

      conversionSemaphore.acquire().then(async () => {
        if (res.destroyed) {
          conversionSemaphore.release();
          return;
        }

        let slotReleased = false;

        const releaseSlot = () => {
          if (!slotReleased) {
            slotReleased = true;
            conversionSemaphore.release();
          }
        };

        res.on("finish", releaseSlot);
        res.on("close", releaseSlot);
        res.on("error", releaseSlot);
        const controller = new AbortController();
        res.once("close", () => controller.abort());

        // 不在此处 res.writeHead(200)。由 pipe() 在首个数据块到达时
        // 自动发送响应头。若 sharp 流在产出数据前报错，headersSent 仍为
        // false，可 writeHead(500).end() 正常关闭，杜绝 ERR_EMPTY_RESPONSE。
        res.setHeader("content-type", "image/png");
        res.setHeader("cache-control", "private, no-cache");

        try {
          const heif = await decodeHeifDisplay(safePath, {
            signal: controller.signal,
            priority: () => 0,
          });
          if (heif) {
            if (!res.destroyed) {
              res.setHeader("content-length", heif.buffer.length);
              res.end(heif.buffer);
            }
            return;
          }
          controller.signal.throwIfAborted();
          await pipeConvertedImage(safePath, res, controller.signal);
        } catch (err) {
          releaseSlot();
          if (!controller.signal.aborted) {
            safeEndError(res, 500, "Image conversion failed");
            log.error(
              `[HttpServer] /image sharp init error for ${safePath}: ${(err as Error)?.message ?? String(err)}`
            );
          }
        }
      });
    })
    .catch((err: NodeJS.ErrnoException) => {
      if (!res.headersSent) {
        const code = err?.code;
        if (code === "ENOENT") {
          res.writeHead(404);
          res.end("Not Found");
        } else if (code === "EACCES" || code === "EPERM") {
          res.writeHead(403);
          res.end("Forbidden");
        } else {
          res.writeHead(500);
          res.end("Internal Server Error");
        }
      }
    });
}

// ── 请求分发 ──────────────────────────────────────────────────────────

async function pipeConvertedImage(
  safePath: string,
  res: http.ServerResponse,
  signal: AbortSignal
) {
  const pipeline = (await createOrientedPipeline(safePath, safePath)).png();
  if (signal.aborted) {
    pipeline.destroy();
    return;
  }
  res.once("close", () => pipeline.destroy());
  pipeline.on("error", (err: Error) => {
    if (res.headersSent) {
      res.destroy();
    } else {
      safeEndError(res, 500, "Image conversion failed");
    }
    log.error(
      `[HttpServer] /image conversion failed for ${safePath}: ${err.message}`
    );
  });
  pipeline.pipe(res);
}

async function serveGalleryThumbnailResult(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  params: URLSearchParams,
  thumbnail: Awaited<ReturnType<typeof generateGalleryThumbnail>>
): Promise<void> {
  const stats =
    thumbnail.stat ?? (await fs.promises.stat(thumbnail.thumbnailPath));
  if (res.destroyed || res.writableEnded) {
    return;
  }
  const repairing = params.get("repair") === "1";
  // A same-size repair can share the damaged file's timestamps. Only this
  // explicit recovery path needs a content validator; normal reads keep the
  // cheap stat-based validator. Generation normally supplies the bytes.
  const revision = repairing
    ? `repair-${createHash("sha256")
        .update(
          thumbnail.buffer ??
            (await fs.promises.readFile(thumbnail.thumbnailPath))
        )
        .digest("hex")}`
    : `${stats.size}-${stats.mtimeMs}-${stats.ctimeMs}`;
  const etag = `"${thumbnail.sourceIdentity}-${path.basename(thumbnail.thumbnailPath)}-${revision}"`;
  res.setHeader("etag", etag);
  res.setHeader(
    "cache-control",
    galleryThumbnailCachePolicy(params, thumbnail.sourceIdentity)
  );
  // The client explicitly reported a decode failure: never reuse its body.
  if (!repairing && req.headers["if-none-match"] === etag) {
    res.writeHead(304);
    res.end();
    return;
  }
  if (thumbnail.buffer) {
    res.setHeader("content-type", "image/webp");
    res.setHeader("content-length", thumbnail.buffer.length);
    res.writeHead(200);
    res.end(thumbnail.buffer);
  } else {
    serveStaticFile(thumbnail.thumbnailPath, res, "image/webp", false, stats);
  }
}

function galleryThumbnailCachePolicy(
  params: URLSearchParams,
  identity: string | undefined
): string {
  if (params.get("repair") === "1") {
    return "private, no-cache";
  }
  if (params.get("select") === "1") {
    return `private, max-age=${GALLERY_CONFIG.imageTransferCacheSeconds}, must-revalidate`;
  }
  return params.get("rv") === identity
    ? "private, max-age=31536000, immutable"
    : "private, no-cache";
}

function offlineCachedPreview(photo: {
  contentRevision: number;
  metadataRevision: number;
  thumbnailPath: string | null;
}): string | null {
  return photo.contentRevision === photo.metadataRevision
    ? photo.thumbnailPath
    : null;
}

async function readOfflinePhotoThumbnail(
  thumbnailPath: string | null,
  signal: AbortSignal
) {
  const cacheRoot = path.join(getDataPath(), "thumbnails");
  const safe = thumbnailPath && resolveSecurePath(thumbnailPath, [cacheRoot]);
  if (!safe || path.extname(safe).toLowerCase() !== ".webp") {
    return null;
  }
  try {
    const stat = await fs.promises.stat(safe);
    if (!stat.isFile()) {
      return null;
    }
    const { metadata, buffer } = await readValidatedThumbnail(safe, stat);
    if (metadata.format !== "webp") {
      return null;
    }
    signal.throwIfAborted();
    return {
      thumbnailPath: safe,
      stat,
      buffer,
      width: metadata.width ?? 0,
      height: metadata.height ?? 0,
      sourceIdentity: undefined,
    };
  } catch {
    return null;
  }
}

function preparePhotoThumbnailReader(db: ReturnType<typeof getDatabase>) {
  return db
    .select({
      path: photos.path,
      width: photos.width,
      height: photos.height,
      sourceStatus: photos.sourceStatus,
      sourceSize: photos.sourceSize,
      sourceMtimeMs: photos.sourceMtimeMs,
      sourceCtimeMs: photos.sourceCtimeMs,
      thumbnailPath: photos.thumbnailPath,
      contentRevision: photos.contentRevision,
      metadataRevision: photos.metadataRevision,
    })
    .from(photos)
    .where(
      and(eq(photos.id, sql.placeholder("photoId")), isNull(photos.deletedAt))
    )
    .prepare();
}

const photoThumbnailReaders = new WeakMap<
  ReturnType<typeof getDatabase>,
  ReturnType<typeof preparePhotoThumbnailReader>
>();

function readPhotoThumbnail(photoId: number) {
  const db = getDatabase();
  let reader = photoThumbnailReaders.get(db);
  if (!reader) {
    reader = preparePhotoThumbnailReader(db);
    photoThumbnailReaders.set(db, reader);
  }
  return reader.get({ photoId });
}

export async function loadPhotoThumbnail(
  params: URLSearchParams,
  signal: AbortSignal,
  priority = 0
) {
  const id = Number(params.get("id"));
  const edge = Number(params.get("edge")) as BrowsePreviewEdge;
  const edges: readonly number[] =
    params.get("browse") === "1"
      ? BROWSE_PREVIEW_EDGES
      : GALLERY_THUMBNAIL_EDGES;
  if (!Number.isSafeInteger(id) || id <= 0 || !edges.includes(edge)) {
    return { status: 400 } as const;
  }
  const photo = readPhotoThumbnail(id);
  if (!photo) {
    return { status: 404 } as const;
  }
  if (
    photo.sourceStatus !== "available" &&
    photo.sourceStatus !== "unverified"
  ) {
    const thumbnail = await readOfflinePhotoThumbnail(
      offlineCachedPreview(photo),
      signal
    );
    return thumbnail
      ? ({ status: 200, kind: "preview", thumbnail, offline: true } as const)
      : ({ status: 404 } as const);
  }
  const safePath = resolveSafePath(photo.path, true);
  if (!safePath) {
    return { status: 403 } as const;
  }
  if (params.get("browse") === "1" && (await needsNativePlayback(safePath))) {
    signal.throwIfAborted();
    return { status: 200, kind: "original", originalPath: safePath } as const;
  }
  const selectExisting = params.get("select") === "1";
  if (selectExisting) {
    recordGalleryMediaStat("thumbnailSelectionRequest");
  }
  recordGalleryMediaStat("thumbnailRequest");
  const thumbnail = await generateGalleryThumbnail(
    safePath,
    edge,
    signal,
    priority,
    photo,
    selectExisting,
    params.get("repair") === "1",
    photo
  );
  return { status: 200, kind: "preview", thumbnail, offline: false } as const;
}

async function handlePhotoThumbnail(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  params: URLSearchParams
): Promise<void> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  res.once("close", cancel);
  try {
    // Browser image requests are interactive. A fetch warms the same resource
    // with background priority, without changing its URL or cache identity.
    const result = await loadPhotoThumbnail(
      params,
      controller.signal,
      params.get("browse") === "1" && req.headers["sec-fetch-dest"] === "empty"
        ? 2
        : 0
    );
    if (controller.signal.aborted) {
      return;
    }
    if (result.status !== 200) {
      safeEndError(res, result.status, "Thumbnail unavailable");
      return;
    }
    if (result.kind === "original") {
      serveBrowseOriginal(
        result.originalPath,
        res,
        req.headers["sec-fetch-dest"] === "empty"
      );
      return;
    }
    if (result.offline) {
      res.setHeader("cache-control", "private, no-cache");
      serveStaticFile(
        result.thumbnail.thumbnailPath,
        res,
        "image/webp",
        false,
        result.thumbnail.stat
      );
      return;
    }
    await serveGalleryThumbnailResult(req, res, params, result.thumbnail);
  } catch (error) {
    if (!(controller.signal.aborted || res.destroyed)) {
      recordGalleryMediaStat("thumbnailFailed");
      const code = (error as NodeJS.ErrnoException).code;
      let status = 500;
      if (code === "ENOENT") {
        status = 404;
      } else if (code === "EACCES" || code === "EPERM") {
        status = 403;
      }
      safeEndError(res, status, "Thumbnail unavailable");
    }
  } finally {
    res.removeListener("close", cancel);
  }
}

function serveBrowseOriginal(
  filePath: string,
  res: http.ServerResponse,
  background: boolean
) {
  if (background) {
    res.writeHead(204, { "cache-control": "no-store" }).end();
    return;
  }
  res.setHeader("cache-control", "private, no-cache");
  serveStaticFile(
    filePath,
    res,
    getMimeType(path.extname(filePath).toLowerCase()),
    false
  );
}

function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse
): void {
  let pathname: string;
  let searchParams: URLSearchParams;

  try {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    pathname = url.pathname;
    searchParams = url.searchParams;
  } catch {
    res.writeHead(400);
    res.end("Bad Request");
    return;
  }

  if (!isAuthorized(req, searchParams)) {
    res.writeHead(401);
    res.end("Unauthorized");
    return;
  }

  if (req.method === "OPTIONS") {
    setCorsHeaders(res, req.headers.origin);
    res.setHeader("access-control-allow-methods", "GET, OPTIONS");
    res.setHeader("access-control-allow-headers", "*");
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method !== "GET") {
    setCorsHeaders(res, req.headers.origin);
    res.writeHead(405);
    res.end("Method Not Allowed");
    return;
  }

  setCorsHeaders(res, req.headers.origin);

  if (pathname === "/shooting-project-preview") {
    handleShootingProjectPreview(res, searchParams).catch(() =>
      safeEndError(res, 500, "Project preview unavailable")
    );
    return;
  }
  if (pathname === "/shooting-project-original") {
    handleShootingProjectOriginal(res, searchParams).catch(() =>
      safeEndError(res, 500, "Project original unavailable")
    );
    return;
  }
  if (pathname === "/photo-thumbnail") {
    handlePhotoThumbnail(req, res, searchParams);
    return;
  }
  const filePath = searchParams.get("path");
  if (!filePath) {
    setCorsHeaders(res, req.headers.origin);
    res.writeHead(400);
    res.end("Missing 'path' query parameter");
    return;
  }

  const safePath = resolveSafePath(
    filePath,
    pathname === "/image" || pathname === "/preview"
  );
  if (!safePath) {
    setCorsHeaders(res, req.headers.origin);
    res.writeHead(403);
    res.end("Forbidden");
    log.warn(`[HttpServer] Security: blocked access to ${filePath}`);
    return;
  }

  switch (pathname) {
    case "/thumbnail":
      handleThumbnail(safePath, res);
      break;
    case "/preview":
      handlePreview(safePath, res);
      break;
    case "/image":
      handleImage(safePath, res);
      break;
    case "/duel-preview":
      handleDuelPreview(safePath, res);
      break;
    default:
      setCorsHeaders(res, req.headers.origin);
      res.writeHead(501);
      res.end("Not Implemented");
  }
}

async function handleShootingProjectPreview(
  res: http.ServerResponse,
  searchParams: URLSearchParams
): Promise<void> {
  const projectId = searchParams.get("projectId") ?? "";
  const photoId = searchParams.get("photoId") ?? "";
  if (
    !(
      PROJECT_MEDIA_ID_PATTERN.test(projectId) &&
      PROJECT_MEDIA_ID_PATTERN.test(photoId)
    ) ||
    searchParams.has("path")
  ) {
    safeEndError(res, 400, "Invalid project photo identifier");
    return;
  }
  const { resolveShootingProjectPreview } = await import("./shooting-projects");
  const previewPath = await resolveShootingProjectPreview(projectId, photoId);
  if (!previewPath) {
    safeEndError(res, 404, "Project preview not found");
    return;
  }
  res.setHeader("cache-control", "private, no-cache");
  serveStaticFile(
    previewPath,
    res,
    getMimeType(path.extname(previewPath).toLowerCase()),
    false
  );
}

async function handleShootingProjectOriginal(
  res: http.ServerResponse,
  searchParams: URLSearchParams
): Promise<void> {
  const projectId = searchParams.get("projectId") ?? "";
  const photoId = searchParams.get("photoId") ?? "";
  if (
    !(
      PROJECT_MEDIA_ID_PATTERN.test(projectId) &&
      PROJECT_MEDIA_ID_PATTERN.test(photoId)
    ) ||
    searchParams.has("path")
  ) {
    safeEndError(res, 400, "Invalid project photo identifier");
    return;
  }
  const { resolveShootingProjectOriginal } = await import(
    "./shooting-project-media"
  );
  const original = await resolveShootingProjectOriginal(projectId, photoId);
  if (!original) {
    safeEndError(res, 404, "Project original not found");
    return;
  }
  handleImage(original, res);
}

// ── 端口重试启动逻辑 ──────────────────────────────────────────────────

const MAX_RETRIES = 10;
const DYNAMIC_PORT_RANGE_START = 49_152;
const DYNAMIC_PORT_RANGE_END = 65_535;

function getRandomDynamicPort(): number {
  return (
    Math.floor(
      Math.random() * (DYNAMIC_PORT_RANGE_END - DYNAMIC_PORT_RANGE_START + 1)
    ) + DYNAMIC_PORT_RANGE_START
  );
}

export function startHttpServerEarly(): Promise<number> {
  if (isServerStarted && serverPort !== null) {
    return Promise.resolve(serverPort);
  }

  return new Promise<number>((resolve, reject) => {
    let attempts = 0;

    function tryListen(): void {
      // Prefer OS-assigned port on first attempt, but if we've
      // already run before (e.g. restart after data migration),
      // reuse the last-used port so the renderer's preload-injected
      // --http-port value stays valid.
      const port =
        attempts === 0 ? (lastUsedPort ?? 0) : getRandomDynamicPort();

      server = http.createServer(handleRequest);

      server.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          attempts++;
          if (attempts < MAX_RETRIES) {
            log.warn(
              `[HttpServer] Port ${port} is occupied, retrying (attempt ${attempts + 1}/${MAX_RETRIES})…`
            );
            server?.close();
            server = null;
            tryListen();
            return;
          }
          reject(
            new Error(
              `[HttpServer] Failed to find an available port after ${MAX_RETRIES} attempts`
            )
          );
          return;
        }
        reject(err);
      });

      server.listen(port, "127.0.0.1", () => {
        const addr = server?.address();
        if (addr && typeof addr === "object") {
          serverPort = addr.port;
          lastUsedPort = addr.port;
          isServerStarted = true;
          console.log(`[HttpServer] Started on http://127.0.0.1:${serverPort}`);
          resolve(serverPort);
        } else {
          reject(new Error("[HttpServer] Failed to obtain server address"));
        }
      });
    }

    tryListen();
  });
}

export function stopHttpServer(): Promise<void> {
  if (!server) {
    isServerStarted = false;
    serverPort = null;
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {
    server?.close(async () => {
      // Socket closure can precede the ReadStream's asynchronous file close.
      // Wait before callers move/remove a data directory on Windows.
      await Promise.all(mediaStreams.values());
      console.log(
        `[HttpServer] Stopped (active conversions: ${conversionSemaphore.active}, queued: ${conversionSemaphore.queued})`
      );
      server = null;
      serverPort = null;
      isServerStarted = false;
      resolve();
    });
    // Renderers may keep image responses open until the window is destroyed,
    // while window destruction waits for quit cleanup. Break that cycle after
    // closing the listener so no new connection can escape this shutdown.
    server?.closeAllConnections();
    for (const stream of mediaStreams.keys()) {
      stream.destroy();
    }
  });
}

// ── 状态查询 ──────────────────────────────────────────────────────────

export function getHttpServerPort(): number | null {
  return serverPort;
}

export function getHttpServerAuthToken(): string {
  return authToken;
}

export function isHttpServerRunning(): boolean {
  return isServerStarted;
}
