import crypto from "node:crypto";
import fs from "node:fs";
import { eq, sql } from "drizzle-orm";
import { getDatabase } from "@/db";
import { duplicatePairs, photos } from "@/db/schema";
import { BKTree } from "./bk-tree";

let bkTreeInstance: BKTree | null = null;
let bkTreeBuiltForMaxId = 0;

function computeFileHash(filePath: string): string | null {
  try {
    const fd = fs.openSync(filePath, "r");
    const stat = fs.fstatSync(fd);
    const size = stat.size;
    const hash = crypto.createHash("sha256");

    if (size <= 8192) {
      const buf = Buffer.alloc(size);
      fs.readSync(fd, buf, 0, size, 0);
      hash.update(buf);
    } else {
      const head = Buffer.alloc(4096);
      fs.readSync(fd, head, 0, 4096, 0);
      hash.update(head);
      const tail = Buffer.alloc(4096);
      fs.readSync(fd, tail, 0, 4096, size - 4096);
      hash.update(tail);
      const sizeBuffer = Buffer.alloc(8);
      sizeBuffer.writeBigInt64LE(BigInt(size));
      hash.update(sizeBuffer);
    }
    fs.closeSync(fd);
    return hash.digest("hex");
  } catch {
    return null;
  }
}

function ensureBKTree(): BKTree {
  const db = getDatabase();
  const maxId =
    db.select({ maxId: sql<number>`max(id)` }).from(photos).get()?.maxId || 0;

  if (bkTreeInstance && bkTreeBuiltForMaxId >= maxId) {
    return bkTreeInstance;
  }

  bkTreeInstance = new BKTree();
  const allHashes = db
    .select({ id: photos.id, phash: photos.phash })
    .from(photos)
    .where(sql`${photos.phash} IS NOT NULL`)
    .all();

  for (const p of allHashes) {
    if (p.phash) {
      bkTreeInstance.insert(p.id, p.phash);
    }
  }
  bkTreeBuiltForMaxId = maxId;
  return bkTreeInstance;
}

export function insertIntoBKTree(photoId: number, phash: string): void {
  if (bkTreeInstance) {
    bkTreeInstance.insert(photoId, phash);
    if (photoId > bkTreeBuiltForMaxId) {
      bkTreeBuiltForMaxId = photoId;
    }
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Duplicate detection intentionally combines exact hash and perceptual hash paths for one database update.
export function checkNewPhotoDuplicates(
  photoId: number,
  phash: string | null,
  filePath: string,
  fileSize: number,
  threshold = 8
): void {
  const db = getDatabase();

  const sameSize = db
    .select({
      id: photos.id,
      path: photos.path,
      contentHash: photos.contentHash,
    })
    .from(photos)
    .where(eq(photos.fileSize, fileSize))
    .all()
    .filter((p) => p.id !== photoId);

  if (sameSize.length > 0) {
    const newHash = computeFileHash(filePath);
    if (newHash) {
      db.update(photos)
        .set({ contentHash: newHash })
        .where(eq(photos.id, photoId))
        .run();

      for (const existing of sameSize) {
        let existingHash = existing.contentHash;
        if (!existingHash) {
          existingHash = computeFileHash(existing.path);
          if (existingHash) {
            db.update(photos)
              .set({ contentHash: existingHash })
              .where(eq(photos.id, existing.id))
              .run();
          }
        }
        if (existingHash && existingHash === newHash) {
          const aId = Math.min(photoId, existing.id);
          const bId = Math.max(photoId, existing.id);
          db.insert(duplicatePairs)
            .values({
              photoAId: aId,
              photoBId: bId,
              matchType: "exact",
              phashDistance: 0,
              status: "confirmed",
            })
            .onConflictDoNothing()
            .run();
        }
      }
    }
  }

  if (phash) {
    const tree = ensureBKTree();
    const neighbors = tree.query(phash, threshold);
    for (const n of neighbors) {
      if (n.photoId === photoId) {
        continue;
      }
      const aId = Math.min(photoId, n.photoId);
      const bId = Math.max(photoId, n.photoId);
      db.insert(duplicatePairs)
        .values({
          photoAId: aId,
          photoBId: bId,
          matchType: "phash",
          phashDistance: n.distance,
          status: n.distance <= 3 ? "confirmed" : "pending",
        })
        .onConflictDoNothing()
        .run();
    }
    insertIntoBKTree(photoId, phash);
  }
}

export function resetBKTree(): void {
  bkTreeInstance = null;
  bkTreeBuiltForMaxId = 0;
}
