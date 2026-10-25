import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDatabase } from "@/db";
import { photos, photoTags, searchDataRevision, tags } from "@/db/schema";
import { MAX_BATCH_TAG_RELATIONS } from "@/lib/batch-tag-limits";
import { invalidateSmartAlbumCache } from "@/services/smart-album-engine";
import {
  getTagSearchRevision,
  invalidateTagSearch,
} from "@/services/tag-search-revision";

type Database = ReturnType<typeof getDatabase>;
type TagRow = typeof photoTags.$inferSelect;
interface Change {
  after?: TagRow;
  before?: TagRow;
  photoId: number;
  tagId: number;
}
interface Receipt {
  changes: Change[];
  expiresAt: number;
  offset: number;
  restoreRemovals: boolean;
  revision: string;
  undoStarted: boolean;
}
const receipts = new WeakMap<Database, Map<string, Receipt>>();
const TTL = 60_000;

function storeFor(db: Database) {
  let store = receipts.get(db);
  if (!store) {
    store = new Map();
    receipts.set(db, store);
  }
  for (const [id, receipt] of store) {
    if (receipt.expiresAt < Date.now()) {
      store.delete(id);
    }
  }
  return store;
}

function revisionFor(db: Database) {
  return `${getTagSearchRevision()}:${db.select({ revision: searchDataRevision.revision }).from(searchDataRevision).where(eq(searchDataRevision.id, 1)).get()?.revision ?? 0}`;
}

function keepReceipt(
  store: Map<string, Receipt>,
  id: string,
  receipt: Receipt
) {
  receipt.expiresAt = Date.now() + TTL;
  store.set(id, receipt);
  const expiry = receipt.expiresAt;
  setTimeout(() => {
    if (store.get(id)?.expiresAt === expiry) {
      store.delete(id);
    }
  }, TTL + 1).unref();
}

function changed() {
  invalidateTagSearch();
  invalidateSmartAlbumCache();
}

export function getBatchTagOptions(db = getDatabase()) {
  return db
    .select({
      id: tags.id,
      name: tags.name,
      color: tags.color,
      parentId: tags.parentId,
    })
    .from(tags)
    .orderBy(tags.name)
    .all();
}

export function getBatchTagSummary(ids: number[], db = getDatabase()) {
  const active = db
    .select({ id: photos.id })
    .from(photos)
    .where(and(inArray(photos.id, ids), isNull(photos.deletedAt)))
    .all();
  const counts = active.length
    ? db
        .select({ id: photoTags.tagId, count: sql<number>`count(*)` })
        .from(photoTags)
        .where(
          inArray(
            photoTags.photoId,
            active.map((photo) => photo.id)
          )
        )
        .groupBy(photoTags.tagId)
        .all()
    : [];
  return { total: active.length, counts };
}

export function applyBatchTags(
  input: {
    ids: number[];
    addTagIds: number[];
    removeTagIds: number[];
    operationId: string;
  },
  db = getDatabase()
) {
  const store = storeFor(db);
  const previous = store.get(input.operationId);
  if (previous?.undoStarted) {
    throw new Error("Tag operation has already been undone");
  }
  const tagIds = [...new Set([...input.addTagIds, ...input.removeTagIds])];
  if (new Set(input.ids).size * tagIds.length > MAX_BATCH_TAG_RELATIONS) {
    throw new Error("Tag batch exceeds the relation budget");
  }
  const validTags = tagIds.length
    ? db
        .select({ id: tags.id })
        .from(tags)
        .where(inArray(tags.id, tagIds))
        .all()
    : [];
  if (validTags.length !== tagIds.length) {
    throw new Error("Tag no longer exists");
  }
  if (input.addTagIds.some((id) => input.removeTagIds.includes(id))) {
    throw new Error("Conflicting tag changes");
  }
  const active = db
    .select({ id: photos.id })
    .from(photos)
    .where(and(inArray(photos.id, input.ids), isNull(photos.deletedAt)))
    .all();
  const revision = revisionFor(db);
  const changes: Change[] = [];
  const addTags = new Set(input.addTagIds);
  const removeTags = new Set(input.removeTagIds);
  db.transaction(() => {
    const existing =
      active.length && tagIds.length
        ? db
            .select()
            .from(photoTags)
            .where(
              and(
                inArray(
                  photoTags.photoId,
                  active.map((photo) => photo.id)
                ),
                inArray(photoTags.tagId, tagIds)
              )
            )
            .all()
        : [];
    const existingByPair = new Map(
      existing.map((row) => [`${row.photoId}:${row.tagId}`, row])
    );
    for (const { id: photoId } of active) {
      for (const tagId of tagIds) {
        const before = existingByPair.get(`${photoId}:${tagId}`);
        if (addTags.has(tagId) && !before) {
          const after = db
            .insert(photoTags)
            .values({
              photoId,
              tagId,
              confidence: null,
              origin: "manual",
              isConfirmed: true,
              userConfirmed: true,
            })
            .returning()
            .get();
          changes.push({ photoId, tagId, after });
        } else if (removeTags.has(tagId) && before) {
          db.delete(photoTags).where(eq(photoTags.id, before.id)).run();
          changes.push({ photoId, tagId, before });
        }
      }
    }
  });
  if (changes.length) {
    changed();
  }
  const receipt: Receipt = previous ?? {
    changes: [],
    offset: 0,
    expiresAt: 0,
    revision,
    restoreRemovals: true,
    undoStarted: false,
  };
  // A missing row has no identity to compare. Be conservative if another tag
  // operation intervened; never resurrect a tag that was subsequently removed.
  if (previous && previous.revision !== revision) {
    receipt.restoreRemovals = false;
  }
  receipt.changes.push(...changes);
  receipt.revision = revisionFor(db);
  keepReceipt(store, input.operationId, receipt);
  return {
    processed: active.length,
    changed: changes.length,
    operationId: input.operationId,
  };
}

export function undoBatchTags(operationId: string, db = getDatabase()) {
  const store = storeFor(db);
  const receipt = store.get(operationId);
  if (!receipt) {
    return { restored: 0, skipped: 0, done: true, expired: true };
  }
  if (receipt.revision !== revisionFor(db)) {
    receipt.restoreRemovals = false;
  }
  receipt.undoStarted = true;
  const slice = receipt.changes.slice(receipt.offset, receipt.offset + 1000);
  let restored = 0;
  db.transaction(() => {
    for (const change of slice) {
      const photo = db
        .select({ id: photos.id })
        .from(photos)
        .where(and(eq(photos.id, change.photoId), isNull(photos.deletedAt)))
        .get();
      if (!photo) {
        continue;
      }
      const current = db
        .select()
        .from(photoTags)
        .where(
          and(
            eq(photoTags.photoId, change.photoId),
            eq(photoTags.tagId, change.tagId)
          )
        )
        .get();
      if (
        change.after &&
        current &&
        JSON.stringify(current) === JSON.stringify(change.after)
      ) {
        db.delete(photoTags).where(eq(photoTags.id, current.id)).run();
        restored++;
      } else if (change.before && !current && receipt.restoreRemovals) {
        const tag = db
          .select({ id: tags.id })
          .from(tags)
          .where(eq(tags.id, change.tagId))
          .get();
        if (!tag) {
          continue;
        }
        const { id: _id, ...original } = change.before;
        db.insert(photoTags).values(original).run();
        restored++;
      }
    }
  });
  receipt.offset += slice.length;
  if (restored) {
    changed();
  }
  receipt.revision = revisionFor(db);
  const done = receipt.offset >= receipt.changes.length;
  if (done) {
    store.delete(operationId);
  } else {
    keepReceipt(store, operationId, receipt);
  }
  return { restored, skipped: slice.length - restored, done, expired: false };
}
