import { os } from "@orpc/server";
import { count, desc, eq, sql } from "drizzle-orm";
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

    if (folderId) {
      return db
        .select({
          id: tags.id,
          name: tags.name,
          color: tags.color,
          photoCount: count(photoTags.photoId).as("photoCount"),
        })
        .from(tags)
        .innerJoin(photoTags, eq(photoTags.tagId, tags.id))
        .innerJoin(photos, eq(photos.id, photoTags.photoId))
        .where(eq(photos.folderId, folderId))
        .groupBy(tags.id)
        .orderBy(desc(sql`photoCount`), tags.name)
        .all();
    }

    return db
      .select({
        id: tags.id,
        name: tags.name,
        color: tags.color,
        photoCount: count(photoTags.photoId).as("photoCount"),
      })
      .from(tags)
      .leftJoin(photoTags, eq(photoTags.tagId, tags.id))
      .groupBy(tags.id)
      .orderBy(desc(sql`photoCount`), tags.name)
      .all();
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
    z.object({ name: z.string().min(1).max(50), color: z.string().optional() })
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
      .values({ name: input.name, color: input.color || null })
      .returning({ insertedId: tags.id })
      .get();
    return {
      id: result?.insertedId,
      name: input.name,
      color: input.color || null,
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
  db.delete(photoTags).where(eq(photoTags.tagId, input.id)).run();
  db.delete(tags).where(eq(tags.id, input.id)).run();
  return { ok: true };
});
