import { getDatabase } from "@/db";
import { folders } from "@/db/schema";
import { getSetting, setSetting } from "@/services/settings-manager";
import {
  expandFaceScanFolderIds,
  normalizeFaceScanFolderIds,
} from "@/utils/face-scan-scope";

const FACE_SCAN_SCOPE_KEY = "faces.scanFolderIds";

function getFolderHierarchy() {
  return getDatabase()
    .select({ id: folders.id, parentId: folders.parentId })
    .from(folders)
    .all();
}

function parseStoredFolderIds(): number[] {
  const raw = getSetting(FACE_SCAN_SCOPE_KEY);
  if (!raw) {
    return [];
  }
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value)
      ? value.filter((id): id is number => typeof id === "number")
      : [];
  } catch {
    return [];
  }
}

export function getFaceScanScope(): {
  configured: boolean;
  folderIds: number[];
} {
  const folderIds = normalizeFaceScanFolderIds(
    getFolderHierarchy(),
    parseStoredFolderIds()
  );
  return { configured: folderIds.length > 0, folderIds };
}

export function setFaceScanScope(folderIds: number[]): {
  configured: boolean;
  folderIds: number[];
} {
  const normalized = normalizeFaceScanFolderIds(
    getFolderHierarchy(),
    folderIds
  );
  if (normalized.length === 0) {
    throw new Error("请至少选择一个有效文件夹");
  }
  setSetting(FACE_SCAN_SCOPE_KEY, JSON.stringify(normalized));
  return { configured: true, folderIds: normalized };
}

export function resolveFaceScanFolderIds(): number[] {
  const hierarchy = getFolderHierarchy();
  return expandFaceScanFolderIds(hierarchy, parseStoredFolderIds());
}
