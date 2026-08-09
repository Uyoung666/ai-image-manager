import fs from "node:fs";
import path from "node:path";

function normalizeForComparison(value: string): string {
  return value.replace(/\\/g, "/").toLowerCase();
}

function isWithinRoot(targetPath: string, rootPath: string): boolean {
  const target = normalizeForComparison(path.resolve(targetPath));
  const root = normalizeForComparison(path.resolve(rootPath));
  return target === root || target.startsWith(`${root}/`);
}

/**
 * Resolve the existing part of a path through the filesystem. This keeps
 * validation useful for paths that will be created later while still
 * detecting symlinks/junctions in all existing path components.
 */
function resolveWithExistingParent(targetPath: string): string | null {
  const resolved = path.resolve(targetPath);
  const missing: string[] = [];
  let existing = resolved;

  while (true) {
    try {
      fs.lstatSync(existing);
      break;
    } catch {
      // Continue walking up until an existing parent is found.
    }
    const parent = path.dirname(existing);
    if (parent === existing) {
      return resolved;
    }
    missing.push(path.basename(existing));
    existing = parent;
  }

  try {
    const realExisting = fs.realpathSync.native(existing);
    return path.join(realExisting, ...missing.reverse());
  } catch {
    try {
      return fs.lstatSync(existing).isSymbolicLink() ? null : resolved;
    } catch {
      return resolved;
    }
  }
}

function resolveRoot(root: string): string {
  const resolved = path.resolve(root);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

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
  return resolveSafePath(targetPath, allowedRoots) !== null;
}

/**
 * Resolve and validate a path against allowed roots. Existing symlinks and
 * Windows junctions are canonicalized before the containment check.
 */
export function resolveSafePath(
  targetPath: string,
  allowedRoots: string[]
): string | null {
  if (!targetPath || allowedRoots.length === 0) {
    return null;
  }

  const resolved = resolveWithExistingParent(targetPath);
  return resolved !== null &&
    allowedRoots.some((root) => isWithinRoot(resolved, resolveRoot(root)))
    ? resolved
    : null;
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
  return resolveSafePath(joined, [basePath]);
}
