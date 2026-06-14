// ── HTTP 端口单例缓存 ──────────────────────────────────────────────────
// 提供异步和同步两种端口获取方式。
// 异步版本通过 IPC 查询主进程（带缓存），同步版本从 preload 注入的
// electronAPI.httpPort 直接读取。

let cachedPort: number | null = null;
let pendingPromise: Promise<number> | null = null;

/**
 * 异步获取 HTTP 服务器端口号（带单例缓存）。
 * 首次调用通过 IPC 向主进程查询，后续调用直接返回缓存值。
 * 如果 HTTP 服务器尚未启动，返回 0。
 */
export async function getHttpPort(): Promise<number> {
  if (cachedPort !== null) {
    return cachedPort;
  }

  if (!pendingPromise) {
    pendingPromise = (async () => {
      const api = window.electronAPI;
      if (!api?.app?.getHttpPort) {
        throw new Error("electronAPI.app.getHttpPort is not available");
      }
      const port: number | null = await api.app.getHttpPort();
      if (port === null || port === 0) {
        throw new Error("HTTP server port is not available");
      }
      return port;
    })();
  }

  cachedPort = await pendingPromise;
  return cachedPort;
}

/**
 * 同步获取当前已缓存的端口号。
 * 仅在 preload 通过 additionalArguments 注入了 httpPort 时可用。
 * 如果端口尚未注入，返回 null。
 */
export function getHttpPortSync(): number | null {
  if (cachedPort !== null) {
    return cachedPort;
  }

  const api = window.electronAPI;
  if (api && typeof api.httpPort === "number" && api.httpPort > 0) {
    cachedPort = api.httpPort;
    return cachedPort;
  }

  return null;
}

/**
 * 重置缓存（通常不需要调用，仅用于测试或服务器重启场景）。
 */
export function clearHttpPortCache(): void {
  cachedPort = null;
  pendingPromise = null;
}
