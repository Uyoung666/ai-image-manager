import { getDatabase } from "@/db";
import { folders } from "@/db/schema";

// ── 文件夹列表缓存：避免每个请求都执行全量 folders 查询 ──────────
// 缓存 TTL 10 秒；索引变更（新建/删除文件夹）通过 invalidateFoldersCache() 主动失效。

let foldersCache: { paths: string[]; timestamp: number } | null = null;
const FOLDERS_CACHE_TTL_MS = 10_000;

/**
 * 获取所有已索引文件夹的路径列表（带缓存）。
 * 如果数据库尚未就绪，回退到空数组，仅允许 dataPath 作为合法根目录。
 */
export function getFolderPaths(): string[] {
  const now = Date.now();
  if (foldersCache && now - foldersCache.timestamp < FOLDERS_CACHE_TTL_MS) {
    return foldersCache.paths;
  }

  try {
    const db = getDatabase();
    const indexedFolders = db
      .select({ path: folders.path })
      .from(folders)
      .all();
    const paths = indexedFolders.map((f) => f.path);
    foldersCache = { paths, timestamp: now };
    return paths;
  } catch {
    // 数据库尚未初始化（HTTP 服务器可能早于数据库启动），
    // 返回上一次缓存的结果或空数组。
    return foldersCache?.paths ?? [];
  }
}

/**
 * 主动失效文件夹路径缓存。
 * 在文件夹创建/删除操作后调用，确保 HTTP 路径安全校验使用最新的目录列表。
 */
export function invalidateFoldersCache(): void {
  foldersCache = null;
}
