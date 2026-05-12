import { os } from "@orpc/server";
import { desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getDatabase } from "@/db";
import { exifData, photos } from "@/db/schema";
import {
  getPhotoVectors,
} from "@/services/ai-embedder";

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
    .where(sql`${exifData.lensModel} IS NOT NULL AND ${exifData.lensModel} != ''`)
    .groupBy(exifData.lensModel)
    .orderBy(desc(sql`count(*)`))
    .limit(8)
    .all();

  // Shooting time heatmap — 24-hour distribution
  const hourData = db
    .select({ dateTaken: exifData.dateTaken })
    .from(exifData)
    .where(sql`${exifData.dateTaken} IS NOT NULL`)
    .all();

  const hourLabels = [
    "00时", "01时", "02时", "03时", "04时", "05时",
    "06时", "07时", "08时", "09时", "10时", "11时",
    "12时", "13时", "14时", "15时", "16时", "17时",
    "18时", "19时", "20时", "21时", "22时", "23时",
  ];
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

  const avgIso =
    db
      .select({ avgIso: sql<number>`avg(${exifData.iso})` })
      .from(exifData)
      .where(sql`${exifData.iso} IS NOT NULL`)
      .get()?.avgIso || 0;

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
      period: hourLabels[hour],
      count,
    })),
    dateRange,
    avgIso,
  };
});

function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) {
    return 64; // Different lengths → max distance
  }
  try {
    const va = BigInt(`0x${a}`);
    const vb = BigInt(`0x${b}`);
    let xor = va ^ vb;
    let dist = 0;
    while (xor > 0n) {
      dist += Number(xor & 1n);
      xor >>= 1n;
    }
    return dist;
  } catch {
    return 64;
  }
}
export const findDuplicates = os
  .input(z.object({ threshold: z.number().optional().default(8) }))
  .handler(async ({ input }) => {
    const db = getDatabase();
    const allPhotos = db
      .select({
        id: photos.id,
        path: photos.path,
        filename: photos.filename,
        phash: photos.phash,
      })
      .from(photos)
      .where(sql`${photos.phash} IS NOT NULL`)
      .all();

    // Phase 1: pHash screening — chunked async to avoid blocking the main process.
    const CHUNK_SIZE = 300;
    const candidates: Array<{
      photoA: { id: number; path: string; filename: string };
      photoB: { id: number; path: string; filename: string };
      distance: number;
    }> = [];

    let compared = 0;
    const totalPairs = (allPhotos.length * (allPhotos.length - 1)) / 2;

    for (let ci = 0; ci < allPhotos.length; ci += CHUNK_SIZE) {
      const chunkEnd = Math.min(ci + CHUNK_SIZE, allPhotos.length);
      const chunk = allPhotos.slice(ci, chunkEnd);

      // Offload each chunk's work into a microtask to keep the UI responsive
      await new Promise<void>((resolve) => {
        setImmediate(() => {
          for (const photoA of chunk) {
            for (const photoB of allPhotos) {
              if (photoA.id >= photoB.id) continue;
              compared++;
              if (photoA.phash && photoB.phash) {
                const dist = hammingDistance(photoA.phash, photoB.phash);
                if (dist <= input.threshold) {
                  candidates.push({
                    photoA: {
                      id: photoA.id,
                      path: photoA.path,
                      filename: photoA.filename,
                    },
                    photoB: {
                      id: photoB.id,
                      path: photoB.path,
                      filename: photoB.filename,
                    },
                    distance: dist,
                  });
                }
              }
            }
          }
          resolve();
        });
      });
      // Log progress periodically
      if (
        ci % (CHUNK_SIZE * 5) === 0 ||
        ci + CHUNK_SIZE >= allPhotos.length
      ) {
        const pct =
          totalPairs > 0
            ? Math.round((compared / totalPairs) * 100)
            : 0;
        console.log(
          `[Dedup] pHash screening: ~${pct}% (${compared}/${totalPairs} pairs, ${candidates.length} candidates)`
        );
      }
    }

    // Phase 2: CLIP vector verification for top candidates.
    const topCandidates = candidates.slice(0, 200);
    const duplicates: Array<{
      photoA: { id: number; path: string; filename: string };
      photoB: { id: number; path: string; filename: string };
      distance: number;
      clipSimilarity?: number;
    }> = [];

    if (topCandidates.length > 0) {
      // Collect unique photo IDs from all candidates
      const uniqueIds = new Set<number>();
      for (const c of topCandidates) {
        uniqueIds.add(c.photoA.id);
        uniqueIds.add(c.photoB.id);
      }

      // Batch-fetch CLIP vectors
      let vectors: Map<number, number[]> = new Map();
      try {
        vectors = await getPhotoVectors(Array.from(uniqueIds));
      } catch {
        // LanceDB unavailable — fall through to pHash-only results
      }

      for (const c of topCandidates) {
        const vecA = vectors.get(c.photoA.id);
        const vecB = vectors.get(c.photoB.id);

        if (vecA && vecB && vecA.length === vecB.length) {
          let dot = 0;
          let normA = 0;
          let normB = 0;
          for (let k = 0; k < vecA.length; k++) {
            dot += vecA[k] * vecB[k];
            normA += vecA[k] * vecA[k];
            normB += vecB[k] * vecB[k];
          }
          const sim = dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
          if (sim > 0.95) {
            duplicates.push({
              ...c,
              clipSimilarity: Math.round(sim * 10_000) / 10_000,
            });
          }
          // else: pHash false positive — drop it
        } else {
          // Vectors not available for one or both — keep pHash result unverified
          duplicates.push(c);
        }
      }
    }

    return { duplicates };
  });
