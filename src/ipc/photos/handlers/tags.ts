import { os } from "@orpc/server";
import { count, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getDatabase } from "@/db";
import { photos, photoTags, tags } from "@/db/schema";
import { suggestTags as aiSuggestTags } from "@/services/ai-embedder";
import { IdSchema } from "./shared";

// AI tag suggestion
export const suggestTags = os.input(IdSchema).handler(async ({ input }) => {
  const db = getDatabase();
  const photo = db
    .select({ path: photos.path })
    .from(photos)
    .where(eq(photos.id, input.id))
    .get();
  if (!photo) {
    return { photoId: input.id, suggestions: [] };
  }
  try {
    const suggestions = await aiSuggestTags(photo.path, 0.25, input.id);
    return { photoId: input.id, suggestions };
  } catch {
    return { photoId: input.id, suggestions: [] };
  }
});

// Tags
export const getTags = os
  .input(z.object({ folderId: z.number().optional() }).optional())
  .handler(({ input }) => {
    const db = getDatabase();
    const folderId = input?.folderId;

    // Fetch all tags
    const allTags = db
      .select()
      .from(tags)
      .orderBy(tags.name)
      .all();

    // Fetch per-tag photo counts
    type TagCountRow = { tagId: number; cnt: number };
    let countRows: TagCountRow[];
    if (folderId) {
      countRows = db
        .select({
          tagId: photoTags.tagId,
          cnt: count(photoTags.photoId).as("cnt"),
        })
        .from(photoTags)
        .innerJoin(photos, eq(photos.id, photoTags.photoId))
        .where(eq(photos.folderId, folderId))
        .groupBy(photoTags.tagId)
        .all() as TagCountRow[];
    } else {
      countRows = db
        .select({
          tagId: photoTags.tagId,
          cnt: count(photoTags.photoId).as("cnt"),
        })
        .from(photoTags)
        .groupBy(photoTags.tagId)
        .all() as TagCountRow[];
    }

    const directCount = new Map<number, number>();
    for (const r of countRows) {
      directCount.set(r.tagId, r.cnt);
    }

    // Build children map
    const childrenMap = new Map<number, number[]>();
    for (const t of allTags) {
      const pid = t.parentId;
      if (pid != null) {
        const list = childrenMap.get(pid);
        if (list) list.push(t.id);
        else childrenMap.set(pid, [t.id]);
      }
    }

    // Recursively compute total count (self + descendants)
    function totalCount(tagId: number, visited: Set<number>): number {
      if (visited.has(tagId)) return 0;
      visited.add(tagId);
      let sum = directCount.get(tagId) || 0;
      const kids = childrenMap.get(tagId);
      if (kids) {
        for (const kid of kids) sum += totalCount(kid, visited);
      }
      return sum;
    }

    const result = allTags.map((t) => ({
      id: t.id,
      name: t.name,
      color: t.color,
      parentId: t.parentId,
      photoCount: totalCount(t.id, new Set()),
    }));

    result.sort((a, b) => b.photoCount - a.photoCount || a.name.localeCompare(b.name));
    return result;
  });

export const getPhotoTags = os.input(IdSchema).handler(({ input }) => {
  const db = getDatabase();
  return db
    .select({
      id: tags.id,
      name: tags.name,
      color: tags.color,
      confidence: photoTags.confidence,
      isConfirmed: photoTags.isConfirmed,
    })
    .from(photoTags)
    .innerJoin(tags, eq(photoTags.tagId, tags.id))
    .where(eq(photoTags.photoId, input.id))
    .all();
});

export const addTag = os
  .input(
    z.object({
      name: z.string().min(1).max(50),
      color: z.string().optional(),
      parentId: z.number().optional(),
    })
  )
  .handler(({ input }) => {
    const db = getDatabase();
    const existing = db
      .select()
      .from(tags)
      .where(eq(tags.name, input.name))
      .get();
    if (existing) {
      return existing;
    }
    const result = db
      .insert(tags)
      .values({
        name: input.name,
        color: input.color || null,
        parentId: input.parentId || null,
      })
      .returning({ insertedId: tags.id })
      .get();
    return {
      id: result?.insertedId,
      name: input.name,
      color: input.color || null,
      parentId: input.parentId || null,
    };
  });

export const setPhotoTag = os
  .input(z.object({ photoId: z.number(), tagId: z.number() }))
  .handler(({ input }) => {
    const db = getDatabase();
    db.insert(photoTags)
      .values({
        photoId: input.photoId,
        tagId: input.tagId,
        isConfirmed: true,
      })
      .onConflictDoNothing()
      .run();
    return { ok: true };
  });

export const removePhotoTag = os
  .input(z.object({ photoId: z.number(), tagId: z.number() }))
  .handler(({ input }) => {
    const db = getDatabase();
    db.delete(photoTags)
      .where(
        sql`${photoTags.photoId} = ${input.photoId} AND ${photoTags.tagId} = ${input.tagId}`
      )
      .run();
    return { ok: true };
  });

export const confirmPhotoTag = os
  .input(z.object({ photoId: z.number(), tagId: z.number() }))
  .handler(({ input }) => {
    const db = getDatabase();
    db.update(photoTags)
      .set({ isConfirmed: true })
      .where(
        sql`${photoTags.photoId} = ${input.photoId} AND ${photoTags.tagId} = ${input.tagId}`
      )
      .run();
    return { ok: true };
  });

export const deleteTag = os.input(IdSchema).handler(({ input }) => {
  const db = getDatabase();
  // Re-parent child tags to root
  db.update(tags)
    .set({ parentId: null })
    .where(eq(tags.parentId, input.id))
    .run();
  db.delete(photoTags).where(eq(photoTags.tagId, input.id)).run();
  db.delete(tags).where(eq(tags.id, input.id)).run();
  return { ok: true };
});
