/** @vitest-environment node */
import { call } from "@orpc/server";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  faceIdentities,
  faceIdentityMembers,
  faceVectors,
  photos,
} from "@/db/schema";

const state = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/db", () => ({ getDatabase: () => state.db }));

import {
  getFaceIdentity,
  listPhotoFaces,
  reviewFace,
} from "@/ipc/faces/handlers";
import { getCurrentFaceIdentityCentroid } from "@/services/face-detector";

let sqlite: Database.Database;
let db: ReturnType<typeof drizzle>;
beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  db = drizzle(sqlite);
  migrate(db, { migrationsFolder: "drizzle" });
  state.db = db;
  db.insert(photos)
    .values({ id: 1, path: "/photo.jpg", filename: "photo.jpg" })
    .run();
  db.insert(faceVectors)
    .values({
      id: 1,
      photoId: 1,
      faceIndex: 0,
      contentRevision: 0,
      bboxX: 0,
      bboxY: 0,
      bboxWidth: 1,
      bboxHeight: 1,
      embedding: JSON.stringify([1, 0]),
    })
    .run();
  db.insert(faceIdentities)
    .values({
      id: 1,
      name: "person",
      isConfirmed: true,
      centroidEmbedding: JSON.stringify([1, 0]),
    })
    .run();
  db.insert(faceIdentityMembers)
    .values({ identityId: 1, faceVectorId: 1 })
    .run();
});
afterEach(() => sqlite.close());

it("keeps confirmed history while excluding it from current faces and centroids", async () => {
  expect(getCurrentFaceIdentityCentroid(1)).toEqual([1, 0]);
  db.update(photos).set({ contentRevision: 1 }).where(eq(photos.id, 1)).run();
  expect(getCurrentFaceIdentityCentroid(1)).toBeNull();
  expect(await call(listPhotoFaces, { photoId: 1 })).toEqual([]);
  expect(await call(getFaceIdentity, { id: 1 })).toMatchObject({
    staleFaceCount: 1,
    faces: [],
  });
  expect(db.select().from(faceIdentityMembers).all()).toHaveLength(1);
});

it("rejects review mutations for an obsolete detected face", async () => {
  db.update(photos).set({ contentRevision: 1 }).where(eq(photos.id, 1)).run();
  await expect(
    call(reviewFace, { faceVectorId: 1, action: "reject" })
  ).rejects.toThrow();
  expect(db.select().from(faceVectors).get()?.isRejected).toBe(false);
});
