import { getHttpPortSync } from "./http-port";
import { preloadImagesWithConcurrency } from "./image-preloader";

const DISPLAY_PIPELINE_VERSION = 2;
const MEDIA_PRELOAD_CONCURRENCY = 4;

function getHttpAuthToken(): string {
  const api = window.electronAPI as typeof window.electronAPI & {
    httpAuthToken?: unknown;
  };
  return typeof api?.httpAuthToken === "string" ? api.httpAuthToken : "";
}

function buildHttpMediaUrl(
  port: number,
  route: string,
  filePath: string
): string {
  const token = getHttpAuthToken();
  const auth = token ? `&token=${encodeURIComponent(token)}` : "";
  return `http://127.0.0.1:${port}/${route}?path=${encodeURIComponent(filePath)}&v=${DISPLAY_PIPELINE_VERSION}${auth}`;
}

/**
 * 将本地文件路径转换为可访问的媒体 URL。
 *
 * 自动根据文件扩展名选择正确的 HTTP 路由：
 * - .webp 文件 → /thumbnail（预生成缩略图）
 * - 其他格式 → /image （可能触发 sharp 实时转换）
 *
 * 端口号由 preload 脚本在窗口创建时通过 --http-port 参数同步注入。
 * 如果 HTTP 端口尚未就绪，回退到原有的 local-media:// 自定义协议。
 */
export function toLocalMediaUrl(filePath: string | null | undefined): string {
  if (!filePath) {
    return "";
  }

  const port = getHttpPortSync();
  if (port !== null) {
    // webp 缩略图走 /thumbnail 路由，非 webp 原始文件走 /image 路由
    const lower = filePath.toLowerCase();
    const route = lower.endsWith(".webp") ? "thumbnail" : "image";
    return buildHttpMediaUrl(port, route, filePath);
  }

  // ── 回退：原有 local-media:// 协议 ──────────────────────────────
  const encoded = filePath
    .replace(/\\/g, "/")
    .split("/")
    .map((s) => encodeURIComponent(s))
    .join("/");
  return `local-media://${encoded}`;
}

/**
 * 显式构造 /preview 路由 URL（提取 RAW 内嵌 JPEG 预览）。
 * 用于大图查看时的首层降级：/preview → /image → 兜底错误。
 */
export function toPreviewUrl(filePath: string | null | undefined): string {
  if (!filePath) {
    return "";
  }

  const port = getHttpPortSync();
  if (port !== null) {
    return buildHttpMediaUrl(port, "preview", filePath);
  }

  // 回退：提取 preview 对 local-media:// 无意义，走通用 URL
  return toLocalMediaUrl(filePath);
}

/**
 * 异步版本：显式等待 HTTP 端口就绪后构建 URL。
 */
export async function toHttpMediaUrl(
  filePath: string | null | undefined
): Promise<string> {
  if (!filePath) {
    return "";
  }

  const { getHttpPort } = await import("./http-port");
  const port = await getHttpPort();
  const lower = filePath.toLowerCase();
  const route = lower.endsWith(".webp") ? "thumbnail" : "image";
  return buildHttpMediaUrl(port, route, filePath);
}

/**
 * 构造对比预览 URL（PK 选片专用 2560px JPEG）。
 * 走 /duel-preview 路由，immutable 缓存。
 */
export function toDuelPreviewUrl(filePath: string | null | undefined): string {
  if (!filePath) {
    return "";
  }
  const port = getHttpPortSync();
  if (port !== null) {
    return buildHttpMediaUrl(port, "duel-preview", filePath);
  }
  // 回退：JPEG 走 /image 路由
  return toLocalMediaUrl(filePath);
}

/**
 * 预加载图片到浏览器缓存。
 */
export async function preloadImageAsync(
  filePath: string | null | undefined,
  concurrency = MEDIA_PRELOAD_CONCURRENCY
): Promise<boolean> {
  if (!filePath) {
    return false;
  }

  const url = toLocalMediaUrl(filePath);
  if (!url) {
    return false;
  }

  try {
    const result = await preloadImagesWithConcurrency([url], concurrency);
    return result.loaded > 0;
  } catch {
    return false;
  }
}

/**
 * 兼容旧调用方的 fire-and-forget 入口；实际加载由并发队列负责。
 */
export function preloadImage(filePath: string | null | undefined): void {
  preloadImageAsync(filePath);
}
