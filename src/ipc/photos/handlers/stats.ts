import crypto from "node:crypto";
import fs from "node:fs";
import { os } from "@orpc/server";
import { desc, eq, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { getDatabase, getDbPath } from "@/db";
import { detectionRuns, duplicatePairs, exifData, photos } from "@/db/schema";
import { getPhotoVectors } from "@/services/ai-embedder";
import { BKTree } from "@/services/bk-tree";
import { computeColorDistribution } from "@/services/color-extractor";
import { getThumbnailDiskUsage } from "@/services/thumbnailer";

// Lightweight: distinct EXIF values for smart album autocomplete
export const getExifCandidates = os.handler(() => {
  const db = getDatabase();

  const cameraModels = db
    .selectDistinct({ val: exifData.cameraModel })
    .from(exifData)
    .where(sql`${exifData.cameraModel} IS NOT NULL AND ${exifData.cameraModel} != ''`)
    .orderBy(exifData.cameraModel)
    .all()
    .map((r) => r.val);

  const lensModels = db
    .selectDistinct({ val: exifData.lensModel })
    .from(exifData)
    .where(sql`${exifData.lensModel} IS NOT NULL AND ${exifData.lensModel} != ''`)
    .orderBy(exifData.lensModel)
    .all()
    .map((r) => r.val);

  const focalLengths = db
    .selectDistinct({ val: exifData.focalLength })
    .from(exifData)
    .where(sql`${exifData.focalLength} IS NOT NULL`)
    .orderBy(exifData.focalLength)
    .all()
    .map((r) => r.val);

  const apertures = db
    .selectDistinct({ val: exifData.aperture })
    .from(exifData)
    .where(sql`${exifData.aperture} IS NOT NULL`)
    .orderBy(exifData.aperture)
    .all()
    .map((r) => r.val);

  const isos = db
    .selectDistinct({ val: exifData.iso })
    .from(exifData)
    .where(sql`${exifData.iso} IS NOT NULL`)
    .orderBy(exifData.iso)
    .all()
    .map((r) => r.val);

  const formats = db
    .selectDistinct({ val: photos.format })
    .from(photos)
    .where(sql`${photos.format} IS NOT NULL AND ${photos.format} != ''`)
    .orderBy(photos.format)
    .all()
    .map((r) => r.val ?? "");

  return { cameraModels, lensModels, focalLengths, apertures, isos, formats };
});

// Color distribution: sample photos, extract multi-color palette via 3D histogram binning
export const getColorDistribution = os.handler(async () => {
  const db = getDatabase();

  const totalCount =
    db
      .select({ count: sql<number>`count(*)` })
      .from(photos)
      .where(sql`${photos.deletedAt} IS NULL AND ${photos.thumbnailPath} IS NOT NULL`)
      .get()?.count ?? 0;

  const samplePhotos = db
    .select({ path: photos.path, thumbnailPath: photos.thumbnailPath })
    .from(photos)
    .where(sql`${photos.deletedAt} IS NULL AND ${photos.thumbnailPath} IS NOT NULL`)
    .orderBy(sql`random()`)
    .limit(200)
    .all();

  return computeColorDistribution(samplePhotos, totalCount);
});

// Statistics for dashboard
export const getStats = os.handler(() => {
  const db = getDatabase();

  const totalPhotos =
    db.select({ count: sql<number>`count(*)` }).from(photos).get()?.count || 0;
  const aiProcessed =
    db
      .select({ count: sql<number>`count(*)` })
      .from(photos)
      .where(eq(photos.isAiProcessed, true))
      .get()?.count || 0;

  const cameraStats = db
    .select({
      model: exifData.cameraModel,
      count: sql<number>`count(*)`,
    })
    .from(exifData)
    .groupBy(exifData.cameraModel)
    .orderBy(desc(sql`count(*)`))
    .limit(5)
    .all();

  const focalStats = db
    .select({
      focalLength: exifData.focalLength,
      count: sql<number>`count(*)`,
    })
    .from(exifData)
    .where(sql`${exifData.focalLength} IS NOT NULL`)
    .groupBy(exifData.focalLength)
    .orderBy(desc(sql`count(*)`))
    .limit(10)
    .all();

  const apertureStats = db
    .select({
      aperture: exifData.aperture,
      count: sql<number>`count(*)`,
    })
    .from(exifData)
    .where(sql`${exifData.aperture} IS NOT NULL`)
    .groupBy(exifData.aperture)
    .orderBy(exifData.aperture)
    .all();
  // ISO distribution by common ranges
  const isoRanges = db
    .select({
      iso: exifData.iso,
    })
    .from(exifData)
    .where(sql`${exifData.iso} IS NOT NULL`)
    .all();

  const isoBuckets = {
    "50-200": 0,
    "200-400": 0,
    "400-800": 0,
    "800-1600": 0,
    "1600+": 0,
  };
  for (const row of isoRanges) {
    const iso = row.iso ?? 0;
    if (iso <= 200) {
      isoBuckets["50-200"]++;
    } else if (iso <= 400) {
      isoBuckets["200-400"]++;
    } else if (iso <= 800) {
      isoBuckets["400-800"]++;
    } else if (iso <= 1600) {
      isoBuckets["800-1600"]++;
    } else {
      isoBuckets["1600+"]++;
    }
  }

  // Lens model distribution
  const lensStats = db
    .select({
      model: exifData.lensModel,
      count: sql<number>`count(*)`,
    })
    .from(exifData)
    .where(
      sql`${exifData.lensModel} IS NOT NULL AND ${exifData.lensModel} != ''`
    )
    .groupBy(exifData.lensModel)
    .orderBy(desc(sql`count(*)`))
    .limit(8)
    .all();

  // Shutter speed distribution
  const shutterData = db
    .select({ shutterSpeed: exifData.shutterSpeed })
    .from(exifData)
    .where(sql`${exifData.shutterSpeed} IS NOT NULL`)
    .all();

  const shutterBuckets = {
    ">1/1000s": 0,
    "1/1000s-1/500s": 0,
    "1/500s-1/250s": 0,
    "1/250s-1/125s": 0,
    "1/125s-1/60s": 0,
    "1/60s-1/30s": 0,
    "<1/30s": 0,
  };
  for (const row of shutterData) {
    const val = Number.parseFloat(row.shutterSpeed ?? "");
    if (Number.isNaN(val)) {
      continue;
    }
    if (val < 0.001) {
      shutterBuckets[">1/1000s"]++;
    } else if (val < 0.002) {
      shutterBuckets["1/1000s-1/500s"]++;
    } else if (val < 0.004) {
      shutterBuckets["1/500s-1/250s"]++;
    } else if (val < 0.008) {
      shutterBuckets["1/250s-1/125s"]++;
    } else if (val < 0.0167) {
      shutterBuckets["1/125s-1/60s"]++;
    } else if (val < 0.0333) {
      shutterBuckets["1/60s-1/30s"]++;
    } else {
      shutterBuckets["<1/30s"]++;
    }
  }

  // Shooting time heatmap — 24-hour distribution
  const hourData = db
    .select({ dateTaken: exifData.dateTaken })
    .from(exifData)
    .where(sql`${exifData.dateTaken} IS NOT NULL`)
    .all();

  const hourBuckets24 = new Array(24).fill(0);
  for (const row of hourData) {
    const hour = new Date(row.dateTaken!).getHours();
    hourBuckets24[hour]++;
  }

  const dateRange = db
    .select({
      earliest: sql<number>`min(${exifData.dateTaken})`,
      latest: sql<number>`max(${exifData.dateTaken})`,
    })
    .from(exifData)
    .get();

  // Yearly shooting stats
  const yearlyStats = db
    .select({
      year: sql<string>`strftime('%Y', ${exifData.dateTaken} / 1000, 'unixepoch')`,
      count: sql<number>`count(*)`,
    })
    .from(exifData)
    .where(sql`${exifData.dateTaken} IS NOT NULL`)
    .groupBy(sql`strftime('%Y', ${exifData.dateTaken} / 1000, 'unixepoch')`)
    .orderBy(sql`strftime('%Y', ${exifData.dateTaken} / 1000, 'unixepoch')`)
    .all();

  // Monthly shooting stats (aggregated across all years)
  const monthlyStats = db
    .select({
      month: sql<string>`strftime('%m', ${exifData.dateTaken} / 1000, 'unixepoch')`,
      count: sql<number>`count(*)`,
    })
    .from(exifData)
    .where(sql`${exifData.dateTaken} IS NOT NULL`)
    .groupBy(sql`strftime('%m', ${exifData.dateTaken} / 1000, 'unixepoch')`)
    .orderBy(sql`strftime('%m', ${exifData.dateTaken} / 1000, 'unixepoch')`)
    .all();

  const avgIso =
    db
      .select({ avgIso: sql<number>`avg(${exifData.iso})` })
      .from(exifData)
      .where(sql`${exifData.iso} IS NOT NULL`)
      .get()?.avgIso || 0;

  // GPS geo-locations for map display
  const geoLocations = db
    .select({
      photoId: exifData.photoId,
      latitude: exifData.gpsLatitude,
      longitude: exifData.gpsLongitude,
      filename: photos.filename,
      path: photos.path,
      width: photos.width,
      height: photos.height,
    })
    .from(exifData)
    .innerJoin(photos, eq(exifData.photoId, photos.id))
    .where(
      sql`${exifData.gpsLatitude} IS NOT NULL AND ${exifData.gpsLongitude} IS NOT NULL AND ${photos.deletedAt} IS NULL`
    )
    .all();

  return {
    totalPhotos,
    aiProcessed,
    cameraStats: cameraStats.filter((c) => c.model),
    lensStats: lensStats.filter((l) => l.model),
    focalStats: focalStats.filter((f) => f.focalLength),
    apertureStats: apertureStats.filter((a) => a.aperture),
    isoDistribution: Object.entries(isoBuckets).map(([range, count]) => ({
      range,
      count,
    })),
    timeHeatmap: hourBuckets24.map((count, hour) => ({
      period: `${hour.toString().padStart(2, "0")}:00`,
      count,
    })),
    shutterSpeedDistribution: Object.entries(shutterBuckets).map(
      ([range, count]) => ({ range, count })
    ),
    yearlyStats,
    monthlyStats,
    dateRange,
    avgIso,
    geoLocations: geoLocations.map((g) => ({
      photoId: g.photoId!,
      latitude: g.latitude!,
      longitude: g.longitude!,
      filename: g.filename,
      path: g.path,
      width: g.width,
      height: g.height,
    })),
  };
});

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

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let k = 0; k < a.length; k++) {
    dot += a[k] * b[k];
    normA += a[k] * a[k];
    normB += b[k] * b[k];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
}

export const findDuplicates = os
  .input(
    z.object({
      threshold: z.number().optional().default(8),
      forceRescan: z.boolean().optional().default(false),
    })
  )
  .handler(async ({ input }) => {
    const db = getDatabase();

    // If not forcing rescan, return persisted results
    if (!input.forceRescan) {
      const existing = db
        .select()
        .from(duplicatePairs)
        .where(
          or(
            eq(duplicatePairs.status, "pending"),
            eq(duplicatePairs.status, "confirmed")
          )
        )
        .all();

      if (existing.length > 0) {
        const photoIds = new Set<number>();
        for (const pair of existing) {
          photoIds.add(pair.photoAId);
          photoIds.add(pair.photoBId);
        }
        const photoMap = new Map<
          number,
          {
            id: number;
            path: string;
            filename: string;
            fileSize: number | null;
            width: number | null;
            height: number | null;
            createdAt: number;
          }
        >();
        const photoRows = db
          .select({
            id: photos.id,
            path: photos.path,
            filename: photos.filename,
            fileSize: photos.fileSize,
            width: photos.width,
            height: photos.height,
            createdAt: photos.createdAt,
          })
          .from(photos)
          .where(inArray(photos.id, Array.from(photoIds)))
          .all();
        for (const p of photoRows) {
          photoMap.set(p.id, p);
        }

        const duplicates = existing
          .map((pair) => {
            const a = photoMap.get(pair.photoAId);
            const b = photoMap.get(pair.photoBId);
            if (!(a && b)) {
              return null;
            }
            return {
              pairId: pair.id,
              photoA: {
                id: a.id,
                path: a.path,
                filename: a.filename,
                fileSize: a.fileSize,
                width: a.width,
                height: a.height,
                createdAt: a.createdAt,
              },
              photoB: {
                id: b.id,
                path: b.path,
                filename: b.filename,
                fileSize: b.fileSize,
                width: b.width,
                height: b.height,
                createdAt: b.createdAt,
              },
              matchType: pair.matchType as "exact" | "phash" | "clip_confirmed",
              distance: pair.phashDistance ?? 0,
              clipSimilarity: pair.clipSimilarity,
              status: pair.status as "pending" | "confirmed",
            };
          })
          .filter(Boolean);

        return { duplicates, fromCache: true };
      }
    }

    // Full detection scan
    const allPhotos = db
      .select({
        id: photos.id,
        path: photos.path,
        filename: photos.filename,
        fileSize: photos.fileSize,
        phash: photos.phash,
        contentHash: photos.contentHash,
        width: photos.width,
        height: photos.height,
        createdAt: photos.createdAt,
      })
      .from(photos)
      .all();

    if (allPhotos.length === 0) {
      return { duplicates: [], fromCache: false };
    }

    // --- Phase 0: Exact duplicate detection via content hash ---
    const sizeGroups = new Map<number, typeof allPhotos>();
    for (const p of allPhotos) {
      if (p.fileSize && p.fileSize > 0) {
        const group = sizeGroups.get(p.fileSize);
        if (group) {
          group.push(p);
        } else {
          sizeGroups.set(p.fileSize, [p]);
        }
      }
    }

    interface CandidatePair {
      clipSimilarity: number | null;
      matchType: "exact" | "phash" | "clip_confirmed";
      phashDistance: number;
      photoAId: number;
      photoBId: number;
    }

    const candidates: CandidatePair[] = [];
    const seenPairs = new Set<string>();

    for (const group of sizeGroups.values()) {
      if (group.length < 2) {
        continue;
      }

      // Compute content hash for photos in this group that don't have one yet
      for (const p of group) {
        if (!p.contentHash) {
          const hash = computeFileHash(p.path);
          if (hash) {
            p.contentHash = hash;
            db.update(photos)
              .set({ contentHash: hash })
              .where(eq(photos.id, p.id))
              .run();
          }
        }
      }

      // Group by content hash
      const hashGroups = new Map<string, typeof group>();
      for (const p of group) {
        if (!p.contentHash) {
          continue;
        }
        const hg = hashGroups.get(p.contentHash);
        if (hg) {
          hg.push(p);
        } else {
          hashGroups.set(p.contentHash, [p]);
        }
      }

      for (const hGroup of hashGroups.values()) {
        if (hGroup.length < 2) {
          continue;
        }
        for (let i = 0; i < hGroup.length; i++) {
          for (let j = i + 1; j < hGroup.length; j++) {
            const aId = Math.min(hGroup[i].id, hGroup[j].id);
            const bId = Math.max(hGroup[i].id, hGroup[j].id);
            const key = `${aId}_${bId}`;
            if (seenPairs.has(key)) {
              continue;
            }
            seenPairs.add(key);
            candidates.push({
              photoAId: aId,
              photoBId: bId,
              matchType: "exact",
              phashDistance: 0,
              clipSimilarity: null,
            });
          }
        }
      }
    }

    // --- Phase 1: BK-Tree pHash near-neighbor search ---
    const photosWithHash = allPhotos.filter((p) => p.phash);
    const bkTree = new BKTree();
    for (const p of photosWithHash) {
      bkTree.insert(p.id, p.phash!);
    }

    let phashProcessed = 0;
    for (const p of photosWithHash) {
      phashProcessed++;
      const neighbors = bkTree.query(p.phash!, input.threshold);
      for (const n of neighbors) {
        if (n.photoId === p.id) {
          continue;
        }
        const aId = Math.min(p.id, n.photoId);
        const bId = Math.max(p.id, n.photoId);
        const key = `${aId}_${bId}`;
        if (seenPairs.has(key)) {
          continue;
        }
        seenPairs.add(key);
        candidates.push({
          photoAId: aId,
          photoBId: bId,
          matchType: "phash",
          phashDistance: n.distance,
          clipSimilarity: null,
        });
      }

      // Yield event loop every 500 photos
      if (phashProcessed % 500 === 0) {
        await new Promise<void>((r) => setImmediate(r));
      }
    }

    // --- Phase 2: CLIP vector verification ---
    // Sort by distance (lower = more likely duplicate)
    candidates.sort((a, b) => a.phashDistance - b.phashDistance);

    const uniqueIds = new Set<number>();
    for (const c of candidates) {
      uniqueIds.add(c.photoAId);
      uniqueIds.add(c.photoBId);
    }

    let vectors: Map<number, number[]> = new Map();
    try {
      vectors = await getPhotoVectors(Array.from(uniqueIds));
    } catch {
      // LanceDB unavailable
    }

    const confirmedPairs: CandidatePair[] = [];

    for (const c of candidates) {
      if (c.matchType === "exact") {
        // Exact SHA-256 match — no CLIP needed
        confirmedPairs.push(c);
        continue;
      }

      const vecA = vectors.get(c.photoAId);
      const vecB = vectors.get(c.photoBId);

      if (vecA && vecB && vecA.length === vecB.length) {
        const sim = cosineSimilarity(vecA, vecB);
        if (sim > 0.95) {
          c.clipSimilarity = Math.round(sim * 10_000) / 10_000;
          c.matchType = "clip_confirmed";
          confirmedPairs.push(c);
        }
      } else {
        // No vectors: use distance-based confidence
        if (c.phashDistance <= 3) {
          // High confidence without CLIP
          confirmedPairs.push(c);
        }
        // distance 4-8 without vectors: skip (too uncertain)
      }
    }

    // --- Persist results ---
    // Clear old results before inserting new ones
    db.delete(duplicatePairs).run();

    if (confirmedPairs.length > 0) {
      for (const pair of confirmedPairs) {
        db.insert(duplicatePairs)
          .values({
            photoAId: pair.photoAId,
            photoBId: pair.photoBId,
            matchType: pair.matchType,
            phashDistance: pair.phashDistance,
            clipSimilarity: pair.clipSimilarity,
            status:
              pair.matchType === "exact" || pair.matchType === "clip_confirmed"
                ? "confirmed"
                : "pending",
          })
          .onConflictDoNothing()
          .run();
      }
    }

    // Record detection run
    const maxId = allPhotos.reduce((max, p) => Math.max(max, p.id), 0);
    db.insert(detectionRuns)
      .values({
        lastPhotoId: maxId,
        photosProcessed: allPhotos.length,
        pairsFound: confirmedPairs.length,
      })
      .run();

    // Build response with photo metadata
    const photoMap = new Map<number, (typeof allPhotos)[0]>();
    for (const p of allPhotos) {
      photoMap.set(p.id, p);
    }

    const duplicates = confirmedPairs
      .map((pair) => {
        const a = photoMap.get(pair.photoAId);
        const b = photoMap.get(pair.photoBId);
        if (!(a && b)) {
          return null;
        }
        return {
          pairId: null as number | null,
          photoA: {
            id: a.id,
            path: a.path,
            filename: a.filename,
            fileSize: a.fileSize,
            width: a.width,
            height: a.height,
            createdAt: a.createdAt,
          },
          photoB: {
            id: b.id,
            path: b.path,
            filename: b.filename,
            fileSize: b.fileSize,
            width: b.width,
            height: b.height,
            createdAt: b.createdAt,
          },
          matchType: pair.matchType as "exact" | "phash" | "clip_confirmed",
          distance: pair.phashDistance,
          clipSimilarity: pair.clipSimilarity,
          status: (pair.matchType === "exact" ||
          pair.matchType === "clip_confirmed"
            ? "confirmed"
            : "pending") as "pending" | "confirmed",
        };
      })
      .filter(Boolean);

    return { duplicates, fromCache: false };
  });

export const dismissDuplicate = os
  .input(z.object({ pairId: z.number() }))
  .handler(({ input }) => {
    const db = getDatabase();
    db.update(duplicatePairs)
      .set({ status: "dismissed", resolvedAt: Date.now() })
      .where(eq(duplicatePairs.id, input.pairId))
      .run();
    return { success: true };
  });

export const getDuplicateStats = os.handler(() => {
  const db = getDatabase();
  const total =
    db.select({ count: sql<number>`count(*)` }).from(duplicatePairs).get()
      ?.count || 0;
  const pending =
    db
      .select({ count: sql<number>`count(*)` })
      .from(duplicatePairs)
      .where(eq(duplicatePairs.status, "pending"))
      .get()?.count || 0;
  const confirmed =
    db
      .select({ count: sql<number>`count(*)` })
      .from(duplicatePairs)
      .where(eq(duplicatePairs.status, "confirmed"))
      .get()?.count || 0;
  const dismissed =
    db
      .select({ count: sql<number>`count(*)` })
      .from(duplicatePairs)
      .where(eq(duplicatePairs.status, "dismissed"))
      .get()?.count || 0;
  const lastRun = db
    .select()
    .from(detectionRuns)
    .orderBy(desc(detectionRuns.completedAt))
    .limit(1)
    .get();
  return { total, pending, confirmed, dismissed, lastRun };
});

// Index info for the settings page: thumbnail cache location/size,
// database file location, and counts of valid vs invalid photo records.
// "Invalid" matches cleanupOrphanPhotos: photos whose folderId is NULL or
// points at a folder that no longer exists.
export const getIndexStats = os
  .input(z.object({}).optional())
  .handler(() => {
    const db = getDatabase();

    const thumb = getThumbnailDiskUsage();
    const databasePath = getDbPath();

    const validPhotoCount =
      db
        .select({ count: sql<number>`count(*)` })
        .from(photos)
        .where(sql`${photos.deletedAt} IS NULL`)
        .get()?.count || 0;

    const invalidPhotoCount =
      db
        .select({ count: sql<number>`count(*)` })
        .from(photos)
        .where(
          sql`${photos.deletedAt} IS NULL AND (${photos.folderId} IS NULL OR ${photos.folderId} NOT IN (SELECT id FROM folders))`
        )
        .get()?.count || 0;

    return {
      thumbnailCacheDir: thumb.dir,
      thumbnailCacheBytes: thumb.bytes,
      thumbnailCacheFileCount: thumb.fileCount,
      databasePath,
      validPhotoCount,
      invalidPhotoCount,
    };
  });
