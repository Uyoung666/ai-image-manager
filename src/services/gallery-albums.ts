import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { getDatabase } from "@/db";
import { albumPhotos, albums, photos } from "@/db/schema";
import { GALLERY_CONFIG } from "@/utils/gallery-config";
import { registerGalleryCleanup } from "@/utils/gallery-lifecycle";
import {
  type GalleryLayoutPhoto,
  getGalleryGeometryRevision,
  getGalleryPhotosByIds,
  getGalleryRevision,
} from "./gallery-listing";
import { getSearchDatabaseRevision } from "./search-revision";
import { evaluateSmartAlbum } from "./smart-album-engine";

interface Snapshot {
  favoriteRevision: number;
  id: string;
  items: GalleryLayoutPhoto[];
  key: string;
  touched: number;
}

interface AlbumSortPhoto {
  fileDate: number | null;
  filename: string;
  fileSize: number | null;
  id: number;
}

// Keep this function self-contained: the same comparator runs in the worker.
function compareAlbumPhotos(
  a: AlbumSortPhoto,
  b: AlbumSortPhoto,
  field: "date" | "name" | "size",
  order: "asc" | "desc",
  locale?: string
): number {
  let comparison = 0;
  if (field === "name") {
    comparison = a.filename.localeCompare(b.filename, locale);
  } else if (field === "size") {
    comparison = (a.fileSize ?? 0) - (b.fileSize ?? 0);
  } else if (a.fileDate === null && b.fileDate !== null) {
    comparison = -1;
  } else if (a.fileDate !== null && b.fileDate === null) {
    comparison = 1;
  } else {
    comparison = (a.fileDate ?? 0) - (b.fileDate ?? 0);
  }
  return (order === "asc" ? 1 : -1) * (comparison || a.id - b.id);
}

const snapshots = new Map<string, Snapshot>();
const pending = new Map<string, Promise<Snapshot>>();
let epoch = 0;
let expiry: ReturnType<typeof setTimeout> | undefined;
function scheduleSnapshotExpiry(): void {
  clearTimeout(expiry);
  if (snapshots.size === 0) {
    expiry = undefined;
    return;
  }
  const next = Math.min(
    ...[...snapshots.values()].map(
      (snapshot) => snapshot.touched + GALLERY_CONFIG.contextTtlMs
    )
  );
  expiry = setTimeout(
    () => {
      for (const [id, snapshot] of snapshots) {
        if (Date.now() - snapshot.touched >= GALLERY_CONFIG.contextTtlMs) {
          snapshots.delete(id);
        }
      }
      scheduleSnapshotExpiry();
    },
    Math.max(1, next - Date.now())
  );
  expiry.unref();
}
export function getGalleryAlbumInfo(id: number) {
  const album = getDatabase()
    .select()
    .from(albums)
    .where(eq(albums.id, id))
    .get();
  if (!album) {
    throw new Error("Album not found");
  }
  return album;
}

export function getGalleryAlbumMemberIds(id: number): number[] {
  const album = getGalleryAlbumInfo(id);
  if (album.isSmart) {
    return album.smartRules
      ? evaluateSmartAlbum(JSON.parse(album.smartRules))
      : [];
  }
  return getDatabase()
    .select({ id: photos.id })
    .from(albumPhotos)
    .innerJoin(photos, eq(albumPhotos.photoId, photos.id))
    .where(and(eq(albumPhotos.albumId, id), isNull(photos.deletedAt)))
    .all()
    .map((row) => row.id);
}

export async function getGalleryAlbumLayout(input: {
  id: number;
  sort: "date" | "name" | "size";
  order: "asc" | "desc";
  locale?: string;
}) {
  const db = getDatabase();
  const generation = epoch;
  const album = getGalleryAlbumInfo(input.id);
  const currentRevision = () =>
    `${album.isSmart ? getGalleryRevision() : getGalleryGeometryRevision()}:${album.isSmart ? getSearchDatabaseRevision(db) : ""}`;
  const revision = currentRevision();
  const key = JSON.stringify({ ...input, revision, rules: album.smartRules });
  const now = Date.now();
  for (const [id, snapshot] of snapshots) {
    if (now - snapshot.touched > GALLERY_CONFIG.contextTtlMs) {
      snapshots.delete(id);
    }
  }
  const cached = [...snapshots.values()].find(
    (snapshot) => snapshot.key === key
  );
  if (cached) {
    if (!album.isSmart && cached.favoriteRevision !== getGalleryRevision()) {
      const favorites = new Map(
        db
          .select({ id: photos.id, favorite: photos.isFavorite })
          .from(albumPhotos)
          .innerJoin(photos, eq(albumPhotos.photoId, photos.id))
          .where(eq(albumPhotos.albumId, input.id))
          .all()
          .map((row) => [row.id, row.favorite])
      );
      for (const item of cached.items) {
        item.isFavorite = favorites.get(item.id) ?? false;
      }
      cached.favoriteRevision = getGalleryRevision();
    }
    cached.touched = now;
    scheduleSnapshotExpiry();
    return { ...cached, revision };
  }
  let job = pending.get(key);
  if (!job) {
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: snapshots share ordinary and smart membership collection and bounded caching.
    job = (async () => {
      const fields = {
        id: photos.id,
        width: photos.width,
        height: photos.height,
        fileDate: photos.fileDate,
        filename: photos.filename,
        fileSize: photos.fileSize,
        isFavorite: photos.isFavorite,
      };
      const rows: Array<{
        id: number;
        width: number | null;
        height: number | null;
        fileDate: number | null;
        filename: string;
        fileSize: number | null;
        isFavorite: boolean | null;
      }> = [];
      if (album.isSmart) {
        const ids = album.smartRules
          ? evaluateSmartAlbum(JSON.parse(album.smartRules))
          : [];
        for (let index = 0; index < ids.length; index += 500) {
          rows.push(
            ...db
              .select(fields)
              .from(photos)
              .where(
                and(
                  inArray(photos.id, ids.slice(index, index + 500)),
                  isNull(photos.deletedAt)
                )
              )
              .all()
          );
          if (index > 0 && index % 5000 === 0) {
            await new Promise((resolve) => setImmediate(resolve));
          }
        }
      } else {
        const members = db
          .select(fields)
          .from(albumPhotos)
          .innerJoin(photos, eq(albumPhotos.photoId, photos.id))
          .where(
            and(eq(albumPhotos.albumId, input.id), isNull(photos.deletedAt))
          )
          .all();
        for (const member of members) {
          rows.push(member);
        }
      }
      const sorted =
        rows.length > GALLERY_CONFIG.layoutWorkerThreshold
          ? await new Promise<typeof rows>((resolve, reject) => {
              const worker = new Worker(
                `const {parentPort,workerData}=require('node:worker_threads');const compare=${compareAlbumPhotos.toString()};parentPort.postMessage(workerData.rows.sort((a,b)=>compare(a,b,workerData.sort,workerData.order,workerData.locale)));`,
                { eval: true, workerData: { rows, ...input } }
              );
              worker.once("message", resolve);
              worker.once("error", reject);
              worker.once("exit", (code) => {
                if (code !== 0) {
                  reject(new Error(`Album sorting worker exited ${code}`));
                }
              });
            })
          : rows.sort((a, b) =>
              compareAlbumPhotos(a, b, input.sort, input.order, input.locale)
            );
      const snapshot = {
        favoriteRevision: getGalleryRevision(),
        key,
        id: randomUUID(),
        touched: Date.now(),
        items: sorted.map(({ id, width, height, fileDate, isFavorite }) => ({
          id,
          width: width ?? 0,
          height: height ?? 0,
          fileDate,
          isFavorite: isFavorite ?? false,
        })),
      };
      while (snapshots.size >= GALLERY_CONFIG.maxContexts) {
        const oldest = [...snapshots.values()].sort(
          (a, b) => a.touched - b.touched
        )[0];
        snapshots.delete(oldest.id);
      }
      if (generation !== epoch || revision !== currentRevision()) {
        throw new Error("ALBUM_SNAPSHOT_EXPIRED");
      }
      snapshots.set(snapshot.id, snapshot);
      scheduleSnapshotExpiry();
      return snapshot;
    })().finally(() => pending.delete(key));
    pending.set(key, job);
  }
  return { ...(await job), revision };
}

export function getGalleryAlbumPage(input: {
  snapshotId: string;
  offset: number;
  limit: number;
}) {
  const snapshot = snapshots.get(input.snapshotId);
  if (
    !snapshot ||
    Date.now() - snapshot.touched > GALLERY_CONFIG.contextTtlMs
  ) {
    throw new Error("ALBUM_SNAPSHOT_EXPIRED");
  }
  snapshot.touched = Date.now();
  scheduleSnapshotExpiry();
  const ids = snapshot.items
    .slice(input.offset, input.offset + input.limit)
    .map((photo) => photo.id);
  const records = new Map(
    getGalleryPhotosByIds(ids).map((photo) => [photo.id, photo])
  );
  return {
    items: ids.flatMap((id) => records.get(id) ?? []),
    total: snapshot.items.length,
    nextOffset:
      input.offset + input.limit < snapshot.items.length
        ? input.offset + input.limit
        : null,
  };
}

export function clearGalleryAlbumSnapshots(): void {
  clearTimeout(expiry);
  expiry = undefined;
  epoch++;
  snapshots.clear();
  pending.clear();
}
registerGalleryCleanup(clearGalleryAlbumSnapshots);
