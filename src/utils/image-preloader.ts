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

interface PreloadTask {
  resolve: (result: "loaded" | "failed") => void;
  url: string;
}

const loadedUrls = new Set<string>();
const inFlightLoads = new Map<string, Promise<"loaded" | "failed">>();
const pendingQueue: PreloadTask[] = [];
let activeLoads = 0;
let globalConcurrency = DEFAULT_CONCURRENCY;

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

    img.onload = () => {
      if (typeof img.decode !== "function") {
        done("loaded");
        return;
      }
      img
        .decode()
        .catch(() => undefined)
        .then(() => done("loaded"));
    };
    img.onerror = () => done("failed");
    img.src = url;
  });
}

function pumpQueue() {
  while (activeLoads < globalConcurrency && pendingQueue.length > 0) {
    const task = pendingQueue.shift();
    if (!task) {
      break;
    }
    activeLoads++;
    loadOne(task.url, SINGLE_TIMEOUT_MS)
      .then((result) => {
        if (result === "loaded") {
          loadedUrls.add(task.url);
        }
        task.resolve(result);
      })
      .catch(() => task.resolve("failed"))
      .finally(() => {
        activeLoads--;
        inFlightLoads.delete(task.url);
        pumpQueue();
      });
  }
}

function enqueueLoad(url: string): Promise<"loaded" | "failed"> {
  if (loadedUrls.has(url)) {
    return Promise.resolve("loaded");
  }

  const inFlight = inFlightLoads.get(url);
  if (inFlight) {
    return inFlight;
  }

  const taskPromise = new Promise<"loaded" | "failed">((resolve) => {
    pendingQueue.push({ resolve, url });
  });
  inFlightLoads.set(url, taskPromise);
  return taskPromise;
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
  const uniqueUrls = [...new Set(urls.filter(Boolean))];
  if (uniqueUrls.length === 0) {
    return { loaded: 0, failed: 0 };
  }

  globalConcurrency = Math.max(1, Math.floor(concurrency));
  const tasks = uniqueUrls.map(enqueueLoad);

  pumpQueue();
  const results = await Promise.all(tasks);
  const loaded = results.filter((result) => result === "loaded").length;
  const failed = results.length - loaded;

  return { loaded, failed };
}
