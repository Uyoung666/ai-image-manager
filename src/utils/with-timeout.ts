/**
 * 为 Promise 添加超时机制。
 * 广泛用于 IPC 调用，防止主进程阻塞时渲染进程无限挂起。
 *
 * @param promise   原始 Promise
 * @param timeoutMs 超时毫秒数
 * @param label     可选标签，在超时错误消息中标识调用来源
 * @returns 原始 Promise 的结果，或在超时后 reject
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label?: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(`IPC 调用${label ? ` "${label}"` : ""} 超时 (${timeoutMs}ms)`)
      );
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
