import http from "node:http";
import https from "node:https";

export interface MirrorHealth {
  error?: string;
  name: string;
  responseTime?: number; // 毫秒
  status: "success" | "failed" | "checking";
  url: string;
}

/**
 * 检查单个镜像源的健康状态
 * 通过 HEAD 请求已知模型文件来测试连通性和速度
 */
async function checkSingleMirror(
  name: string,
  baseUrl: string,
  timeout = 8000
): Promise<MirrorHealth> {
  // Use the active embedding model's small config file for connectivity checks.
  const testPath = "/Xenova/siglip-base-patch16-224/resolve/main/config.json";
  const fullUrl = `${baseUrl}${testPath}`;

  return new Promise((resolve) => {
    const startTime = Date.now();
    const protocol = baseUrl.startsWith("https") ? https : http;

    const req = protocol.request(
      fullUrl,
      {
        method: "HEAD",
        timeout,
        headers: {
          "User-Agent": "AI-Image-Manager/1.0",
        },
      },
      (res) => {
        const responseTime = Date.now() - startTime;

        // 2xx 或 3xx 都算成功（有些镜像会重定向）
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 400) {
          resolve({
            url: baseUrl,
            name,
            status: "success",
            responseTime,
          });
        } else {
          resolve({
            url: baseUrl,
            name,
            status: "failed",
            error: `HTTP ${res.statusCode}`,
          });
        }
      }
    );

    req.on("error", (err) => {
      resolve({
        url: baseUrl,
        name,
        status: "failed",
        error: err.message,
      });
    });

    req.on("timeout", () => {
      req.destroy();
      resolve({
        url: baseUrl,
        name,
        status: "failed",
        error: "Timeout",
      });
    });

    req.end();
  });
}

/**
 * 并行检测所有镜像源的健康状态
 * @returns 各镜像源的健康状态数组，按响应时间排序
 */
export async function checkAllMirrors(): Promise<MirrorHealth[]> {
  const mirrors = [
    { name: "official", url: "https://huggingface.co" },
    { name: "hf-mirror", url: "https://hf-mirror.com" },
    { name: "modelscope", url: "https://modelscope.cn" },
  ];

  console.log("[MirrorHealth] Starting health check for all mirrors...");

  // 并行检测所有镜像源
  const results = await Promise.all(
    mirrors.map((m) => checkSingleMirror(m.name, m.url))
  );

  // 成功的按响应时间排序，失败的放后面
  const sorted = results.sort((a, b) => {
    if (a.status === "success" && b.status === "failed") {
      return -1;
    }
    if (a.status === "failed" && b.status === "success") {
      return 1;
    }
    if (a.status === "success" && b.status === "success") {
      return (a.responseTime || 0) - (b.responseTime || 0);
    }
    return 0;
  });

  console.log(
    "[MirrorHealth] Check complete:",
    sorted.map((r) => ({
      name: r.name,
      status: r.status,
      time: r.responseTime,
    }))
  );

  return sorted;
}

/**
 * 获取推荐的镜像源（最快的可用源）
 */
export function getRecommendedMirror(results: MirrorHealth[]): string | null {
  const fastest = results.find((r) => r.status === "success");
  return fastest?.name || null;
}
