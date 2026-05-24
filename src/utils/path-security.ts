import path from "node:path";

/**
 * 验证路径是否在允许的目录范围内，防止路径遍历攻击
 * @param targetPath 要验证的目标路径
 * @param allowedRoots 允许的根目录列表
 * @returns 如果路径安全则返回 true，否则返回 false
 */
export function isSafePath(
  targetPath: string,
  allowedRoots: string[]
): boolean {
  const resolved = path.resolve(targetPath);
  const normalized = resolved.replace(/\\/g, "/").toLowerCase();

  return allowedRoots.some((root) => {
    const normalizedRoot = `${path.resolve(root).replace(/\\/g, "/").toLowerCase()}/`;
    return (
      normalized.startsWith(normalizedRoot) ||
      normalized === normalizedRoot.slice(0, -1)
    );
  });
}

/**
 * 安全地拼接路径，确保结果路径在基础路径范围内
 * @param basePath 基础路径
 * @param segments 要拼接的路径片段
 * @returns 如果路径安全则返回拼接后的路径，否则返回 null
 */
export function safeJoin(
  basePath: string,
  ...segments: string[]
): string | null {
  const joined = path.join(basePath, ...segments);
  const resolved = path.resolve(joined);

  if (!isSafePath(resolved, [basePath])) {
    return null;
  }

  return resolved;
}
