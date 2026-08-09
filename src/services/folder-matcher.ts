import path from "node:path";
import { getDatabase } from "@/db";
import { folders } from "@/db/schema";

interface FolderEntry {
  depth: number;
  id: number;
  normalizedPath: string;
  path: string;
}

export class FolderMatcher {
  private folders: FolderEntry[] = [];
  private readonly cache = new Map<string, number | null>();
  private readonly MAX_CACHE_SIZE = 10_000;

  constructor() {
    this.reload();
  }

  reload(): void {
    const db = getDatabase();
    const allFolders = db
      .select({ id: folders.id, path: folders.path })
      .from(folders)
      .all();

    this.folders = allFolders
      .map((f) => ({
        id: f.id,
        path: f.path,
        normalizedPath: this.normalizePath(f.path),
        depth: f.path.split(path.sep).length,
      }))
      .sort((a, b) => b.depth - a.depth);

    this.cache.clear();
  }

  match(filePath: string): number | null {
    const normalized = this.normalizePath(filePath);

    const cached = this.cache.get(normalized);
    if (cached !== undefined || this.cache.has(normalized)) {
      return cached ?? null;
    }

    let matchedId: number | null = null;
    for (const folder of this.folders) {
      if (normalized.startsWith(`${folder.normalizedPath}/`)) {
        matchedId = folder.id;
        break;
      }
    }

    if (this.cache.size >= this.MAX_CACHE_SIZE) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }
    this.cache.set(normalized, matchedId);

    return matchedId;
  }

  private normalizePath(p: string): string {
    return p.replace(/\\/g, "/").toLowerCase();
  }
}

let matcherInstance: FolderMatcher | null = null;

export function getFolderMatcher(): FolderMatcher {
  if (!matcherInstance) {
    matcherInstance = new FolderMatcher();
  }
  return matcherInstance;
}

export function reloadFolderMatcher(): void {
  if (matcherInstance) {
    matcherInstance.reload();
  }
}
