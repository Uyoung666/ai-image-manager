import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import sharp from "sharp";
import { extractRawPreview, isRawFile } from "@/services/raw-preview";
import { getDataPath } from "@/utils/data-path";
import { getFolderPaths } from "@/utils/folder-paths";
import { isSafePath } from "@/utils/path-security";

// ── 服务器实例与状态 ──────────────────────────────────────────────────

let server: http.Server | null = null;
let serverPort: number | null = null;
let isServerStarted = false;
// 保存首次分配的端口号，重启时复用，避免 renderer 持有的
// preload 注入端口（通过 --http-port）在迁移后失效。
let lastUsedPort: number | null = null;

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

// ── 安全关闭响应 ──────────────────────────────────────────────────────

function safeEndError(
  res: http.ServerResponse,
  status: number,
  body: string
): void {
  if (res.headersSent) {
    res.destroy();
  } else {
    res.writeHead(status);
    res.end(body);
  }
}

// ── CORS 响应头 ───────────────────────────────────────────────────────

function setCorsHeaders(res: http.ServerResponse): void {
  res.setHeader("access-control-allow-origin", "*");
}

// ── 路径安全校验 ──────────────────────────────────────────────────────

function resolveSafePath(targetPath: string): string | null {
  const resolved = path.resolve(targetPath);
  const allowedRoots = [getDataPath(), ...getFolderPaths()];

  if (!isSafePath(resolved, allowedRoots)) {
    return null;
  }

  return resolved;
}

// ── 路由：GET /thumbnail ──────────────────────────────────────────────

function handleThumbnail(safePath: string, res: http.ServerResponse): void {
  setCorsHeaders(res);

  fs.promises
    .stat(safePath)
    .then((stats) => {
      if (!stats.isFile()) {
        res.writeHead(404);
        res.end("Not a file");
        return;
      }

      const diskExt = path.extname(safePath).toLowerCase();
      res.setHeader("content-type", getMimeType(diskExt));
      res.setHeader("cache-control", "public, max-age=31536000, immutable");
      res.setHeader("content-length", stats.size);
      res.writeHead(200);

      const readStream = fs.createReadStream(safePath);

      readStream.on("error", (err) => {
        if (res.headersSent) {
          res.destroy();
        } else {
          res.writeHead(500);
          res.end("Internal Server Error");
        }
        console.warn(
          `[HttpServer] /thumbnail stream error for ${safePath}: ${(err as Error)?.message ?? String(err)}`
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
        console.warn(
          `[HttpServer] /thumbnail error for ${safePath}: ${(err as Error)?.message ?? String(err)}`
        );
      }
    });
}

/** /duel-preview 路由 — 预生成的 2560px JPEG 对比预览（PK 选片专用） */
function handleDuelPreview(
  safePath: string,
  res: http.ServerResponse
): void {
  setCorsHeaders(res);

  fs.promises
    .stat(safePath)
    .then((stats) => {
      if (!stats.isFile()) {
        res.writeHead(404);
        res.end("Not a file");
        return;
      }

      res.setHeader("content-type", "image/jpeg");
      res.setHeader("cache-control", "public, max-age=31536000, immutable");
      res.setHeader("content-length", stats.size);
      res.writeHead(200);

      const readStream = fs.createReadStream(safePath);

      readStream.on("error", (err) => {
        if (res.headersSent) {
          res.destroy();
        } else {
          res.writeHead(500);
          res.end("Internal Server Error");
        }
        console.warn(
          `[HttpServer] /duel-preview stream error for ${safePath}: ${(err as Error)?.message ?? String(err)}`
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

// ── 路由：GET /preview ────────────────────────────────────────────────

async function handlePreview(
  safePath: string,
  res: http.ServerResponse
): Promise<void> {
  setCorsHeaders(res);

  const ext = path.extname(safePath).toLowerCase();

  if (!isRawFile(safePath)) {
    console.warn(
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
    console.error(
      `[HttpServer] /preview stat failed: path=${safePath} code=${code} message=${(err as Error).message}`
    );
    if (!res.headersSent) {
      res.writeHead(code === "ENOENT" ? 404 : 500);
      res.end(code === "ENOENT" ? "Not Found" : "Internal Server Error");
    }
    return;
  }

  if (!stats.isFile()) {
    console.warn(
      `[HttpServer] /preview rejected: path is not a file — path=${safePath}`
    );
    res.writeHead(404);
    res.end("Not a file");
    return;
  }

  console.log(
    `[HttpServer] /preview extracting: path=${safePath} size=${stats.size} ext=${ext}`
  );

  let preview: Buffer | null = null;
  const extractStart = Date.now();

  try {
    preview = await extractRawPreview(safePath);
  } catch (err) {
    console.error(
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
    console.warn(
      `[HttpServer] /preview returned null — all 4 extraction stages failed. path=${safePath} ext=${ext} size=${stats.size} elapsed=${extractMs}ms`
    );
    res.writeHead(404);
    res.end("No embedded preview available");
    return;
  }

  if (preview.length === 0) {
    console.error(
      `[HttpServer] /preview returned EMPTY buffer — length=0. path=${safePath} elapsed=${extractMs}ms`
    );
    res.writeHead(404);
    res.end("No embedded preview available");
    return;
  }

  console.log(
    `[HttpServer] /preview OK: path=${safePath} size=${preview.length} bytes elapsed=${extractMs}ms`
  );

  res.setHeader("content-type", "image/jpeg");
  res.setHeader("cache-control", "public, max-age=86400");
  res.setHeader("content-length", preview.length);
  res.writeHead(200);
  res.end(preview);
}

// ── 路由：GET /image ──────────────────────────────────────────────────
// RAW → extractRawPreview (不走 sharp)，browser-compatible → 直接流式，
// HEIC/TIFF 等 → sharp({failOn:"none"}).png().pipe(res) 并发上限 4。

function handleImage(
  safePath: string,
  res: http.ServerResponse,
  req: http.IncomingMessage
): void {
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
        console.log(
          `[HttpServer] /image RAW → extractRawPreview: path=${safePath} ext=${ext}`
        );

        const extractStart = Date.now();
        let preview: Buffer | null = null;

        try {
          preview = await extractRawPreview(safePath);
        } catch (err) {
          console.error(
            `[HttpServer] /image extractRawPreview THREW: path=${safePath} error=${(err as Error).message}`
          );
          safeEndError(res, 500, "Preview extraction failed");
          return;
        }

        if (!preview || preview.length === 0) {
          console.error(
            `[HttpServer] /image extractRawPreview failed: path=${safePath} elapsed=${Date.now() - extractStart}ms`
          );
          safeEndError(res, 500, "No embedded preview available");
          return;
        }

        console.log(
          `[HttpServer] /image RAW preview OK: path=${safePath} size=${preview.length} bytes elapsed=${Date.now() - extractStart}ms`
        );

        res.setHeader("content-type", "image/jpeg");
        res.setHeader("cache-control", "public, max-age=86400");
        res.setHeader("content-length", preview.length);
        res.writeHead(200);
        res.end(preview);
        return;
      }

      // ── 路径 2：浏览器原生兼容 → 直接流式输出 ──────────────
      if (isBrowserCompatible(ext)) {
        const mimeType = getMimeType(ext);
        res.setHeader("content-type", mimeType);
        res.setHeader("cache-control", "public, max-age=86400");
        res.setHeader("content-length", stats.size);
        res.writeHead(200);

        const readStream = fs.createReadStream(safePath);

        readStream.on("error", (err) => {
          if (res.headersSent) {
            res.destroy();
          } else {
            res.writeHead(500);
            res.end("Internal Server Error");
          }
          console.warn(
            `[HttpServer] /image static stream error for ${safePath}: ${(err as Error)?.message ?? String(err)}`
          );
        });

        readStream.pipe(res);
        return;
      }

      // ── 路径 3：其他需转换格式 (HEIC/TIFF/…) → sharp 流式转换 ──
      // 受并发信号量保护，上限 4 个同时转换。
      console.log(
        `[HttpServer] /image converting via sharp: path=${safePath} ext=${ext} size=${stats.size}`
      );

      conversionSemaphore.acquire().then(() => {
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
        req.on("close", () => {
          setTimeout(releaseSlot, 100);
        });

        // 不在此处 res.writeHead(200)。由 pipe() 在首个数据块到达时
        // 自动发送响应头。若 sharp 流在产出数据前报错，headersSent 仍为
        // false，可 writeHead(500).end() 正常关闭，杜绝 ERR_EMPTY_RESPONSE。
        res.setHeader("content-type", "image/png");
        res.setHeader("cache-control", "public, max-age=86400");

        try {
          const sharpStream = sharp(safePath, { failOn: "none" })
            .rotate()
            .png();

          sharpStream.on("error", (err: Error) => {
            releaseSlot();
            if (res.headersSent) {
              // 已经向浏览器发送了部分 PNG 数据，无法再发送错误页。
              // 只能销毁连接。
              res.destroy();
            } else {
              // 尚未发送任何数据 — 正常返回 500 错误页，
              // 杜绝 ERR_EMPTY_RESPONSE。
              res.writeHead(500);
              res.end("Image conversion failed");
            }
            console.error(
              `[HttpServer] /image sharp conversion error for ${safePath}: ${err.message}`
            );
          });

          sharpStream.pipe(res);
        } catch (err) {
          releaseSlot();
          if (!res.headersSent) {
            res.writeHead(500);
            res.end("Image conversion failed");
          }
          console.error(
            `[HttpServer] /image sharp init error for ${safePath}: ${(err as Error)?.message ?? String(err)}`
          );
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

  if (req.method === "OPTIONS") {
    setCorsHeaders(res);
    res.setHeader("access-control-allow-methods", "GET, OPTIONS");
    res.setHeader("access-control-allow-headers", "*");
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method !== "GET") {
    setCorsHeaders(res);
    res.writeHead(405);
    res.end("Method Not Allowed");
    return;
  }

  const filePath = searchParams.get("path");
  if (!filePath) {
    setCorsHeaders(res);
    res.writeHead(400);
    res.end("Missing 'path' query parameter");
    return;
  }

  const safePath = resolveSafePath(filePath);
  if (!safePath) {
    setCorsHeaders(res);
    res.writeHead(403);
    res.end("Forbidden");
    console.warn(`[HttpServer] Security: blocked access to ${filePath}`);
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
      handleImage(safePath, res, req);
      break;
    case "/duel-preview":
      handleDuelPreview(safePath, res);
      break;
    default:
      setCorsHeaders(res);
      res.writeHead(501);
      res.end("Not Implemented");
  }
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
            console.warn(
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
    server?.close(() => {
      console.log(
        `[HttpServer] Stopped (active conversions: ${conversionSemaphore.active}, queued: ${conversionSemaphore.queued})`
      );
      server = null;
      serverPort = null;
      isServerStarted = false;
      resolve();
    });
  });
}

// ── 状态查询 ──────────────────────────────────────────────────────────

export function getHttpServerPort(): number | null {
  return serverPort;
}

export function isHttpServerRunning(): boolean {
  return isServerStarted;
}
