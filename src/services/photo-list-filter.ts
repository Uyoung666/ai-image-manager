import { eq, inArray, isNull, like, type SQL, sql } from "drizzle-orm";
import { getDatabase } from "@/db";
import { folders, photoSequenceMembers, photos, tags } from "@/db/schema";
import { getFolderSubtreeIds } from "./folder-hierarchy";

export interface PhotoListFilter {
  favoriteOnly?: boolean;
  folderId?: number;
  search?: string;
  tagId?: number;
  tagIds?: number[];
  tagMode?: "and" | "or";
  ungroupedOnly?: boolean;
}
const GLOB_WILDCARD_RE = /[*?[]/;
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: preserve the shared legacy folder, tag, favorite and ungrouped predicates exactly.
export function buildPhotoListFilter(input: PhotoListFilter) {
  const db = getDatabase();
  const {
    folderId,
    ungroupedOnly,
    tagId,
    tagIds,
    tagMode,
    search,
    favoriteOnly,
  } = input;
  // Always exclude soft-deleted photos
  const conditions: SQL[] = [isNull(photos.deletedAt)];
  let ungroupedCondition: SQL | null = null;

  if (folderId) {
    const folderHierarchy = db
      .select({ id: folders.id, parentId: folders.parentId })
      .from(folders)
      .all();
    const folderIds = getFolderSubtreeIds(folderHierarchy, folderId);
    conditions.push(
      folderIds.length > 0
        ? inArray(photos.folderId, folderIds)
        : eq(photos.folderId, folderId)
    );
  }

  // Multi-tag filtering with AND/OR support
  // Backward compat: if tagId is provided without tagIds, treat as single-tag OR
  let effectiveTagIds: number[] | null = null;
  let effectiveTagMode: "and" | "or" = "or";
  if (tagIds && tagIds.length > 0) {
    effectiveTagIds = tagIds;
    effectiveTagMode = tagMode ?? "or";
  } else if (tagId != null) {
    effectiveTagIds = [tagId];
  }
  let selectedDescendantIds: number[] = [];

  if (effectiveTagIds && effectiveTagIds.length > 0) {
    // Collect all descendant tag IDs for each root tag
    const allTags = db.select().from(tags).all();
    const childrenMap = new Map<number, number[]>();
    for (const t of allTags) {
      if (t.parentId != null) {
        const list = childrenMap.get(t.parentId);
        if (list) {
          list.push(t.id);
        } else {
          childrenMap.set(t.parentId, [t.id]);
        }
      }
    }

    // Collect descendants for each root tag ID
    const rootDescendantSets: Set<number>[] = [];
    for (const rootId of effectiveTagIds) {
      const descendantIds = new Set<number>();
      const visited = new Set<number>();
      (function collect(pid: number) {
        if (visited.has(pid)) {
          return;
        }
        visited.add(pid);
        descendantIds.add(pid);
        const kids = childrenMap.get(pid);
        if (kids) {
          for (const kid of kids) {
            collect(kid);
          }
        }
      })(rootId);
      rootDescendantSets.push(descendantIds);
    }

    if (effectiveTagMode === "or") {
      // OR mode: photo must have at least one tag from the merged descendant set
      const allDescendantIds = new Set<number>();
      for (const set of rootDescendantSets) {
        for (const id of set) {
          allDescendantIds.add(id);
        }
      }
      const idArray = [...allDescendantIds];
      selectedDescendantIds = idArray;
      if (idArray.length > 0) {
        // sql.join builds parameterized IN clause: pt.tag_id IN ($1, $2, $3)
        const inClause = sql.join(
          idArray.map((id) => sql`${id}`),
          sql`, `
        );
        conditions.push(
          sql`${photos.id} IN (SELECT pt.photo_id FROM photo_tags pt WHERE pt.tag_id IN (${inClause}))`
        );
      }
    } else {
      // AND mode: photo must have at least one tag from each root tag's descendant set
      selectedDescendantIds = [
        ...new Set(rootDescendantSets.flatMap((set) => [...set])),
      ];
      for (const descendantSet of rootDescendantSets) {
        const idArray = [...descendantSet];
        if (idArray.length > 0) {
          const inClause = sql.join(
            idArray.map((id) => sql`${id}`),
            sql`, `
          );
          conditions.push(
            sql`EXISTS (SELECT 1 FROM photo_tags pt WHERE pt.photo_id = ${photos.id} AND pt.tag_id IN (${inClause}))`
          );
        }
      }
    }
  }
  if (search) {
    if (GLOB_WILDCARD_RE.test(search)) {
      conditions.push(sql`LOWER(${photos.filename}) GLOB LOWER(${search})`);
    } else {
      conditions.push(like(photos.filename, `%${search}%`));
    }
  }
  if (favoriteOnly) {
    conditions.push(eq(photos.isFavorite, true));
  }
  if (ungroupedOnly) {
    ungroupedCondition = sql`NOT EXISTS (SELECT 1 FROM ${photoSequenceMembers} WHERE ${photoSequenceMembers.photoId} = ${photos.id})`;
    conditions.push(ungroupedCondition);
  }

  return {
    conditions,
    effectiveTagIds,
    effectiveTagMode,
    selectedDescendantIds,
    ungroupedCondition,
  };
}
