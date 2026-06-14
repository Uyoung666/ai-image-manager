/**
 * 并发控制的图片预加载工具。
 *
 * 问题：new Image().src 是 fire-and-forget，在数千张照片的数据集上
 * 瞬间创建大量 Image 对象会塞满浏览器的网络请求队列，导致：
 * - 可见区域的卡片缩略图被排到队尾，首屏加载反而变慢
 * - 内存压力增大（每张解码中的图片都占用内存）
 *
 * 方案：Promise 队列 + 并发上限，控制同时在途的 Image 加载数量。
 * 配合单图超时，防止个别慢请求拖垮整个队列。
 */

const DEFAULT_CONCURRENCY = 12;
const SINGLE_TIMEOUT_MS = 8000;

/**
 * 加载单张图片，返回 Promise。
 * 超时或失败均视为完成（不阻塞队列），以 loaded/failed 统计区分。
 */
function loadOne(url: string, timeoutMs: number): Promise<"loaded" | "failed"> {
  return new Promise((resolve) => {
    const img = new Image();
    let settled = false;

    const done = (result: "loaded" | "failed") => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      // 中断未完成的请求
      if (result === "failed") {
        img.src = "";
      }
      resolve(result);
    };

    const timer = setTimeout(() => done("failed"), timeoutMs);

    img.onload = () => done("loaded");
    img.onerror = () => done("failed");
    img.src = url;
  });
}

/**
 * 并发控制批量预加载。
 *
 * @param urls  已经过 toLocalMediaUrl 转换的 local-media:// URL 数组
 * @param concurrency  最大并发数（默认 12）
 * @returns 已加载和失败的数量
 */
export async function preloadImagesWithConcurrency(
  urls: string[],
  concurrency = DEFAULT_CONCURRENCY
): Promise<{ loaded: number; failed: number }> {
  if (urls.length === 0) {
    return { loaded: 0, failed: 0 };
  }

  let loaded = 0;
  let failed = 0;
  const queue = [...urls];

  async function worker() {
    while (queue.length > 0) {
      const url = queue.shift()!;
      const result = await loadOne(url, SINGLE_TIMEOUT_MS);
      if (result === "loaded") {
        loaded++;
      } else {
        failed++;
      }
    }
  }

  const workerCount = Math.min(concurrency, urls.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return { loaded, failed };
}
