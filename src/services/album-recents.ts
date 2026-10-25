import { eq, inArray } from "drizzle-orm";
import { getDatabase } from "@/db";
import { albums, appSettings } from "@/db/schema";

const KEY = "recent_album_ids";

export function getRecentAlbums(db = getDatabase()) {
  let ids: number[] = [];
  try {
    const value: unknown = JSON.parse(
      db.select().from(appSettings).where(eq(appSettings.key, KEY)).get()
        ?.value ?? "[]"
    );
    if (Array.isArray(value)) {
      ids = [
        ...new Set(
          value.filter((id): id is number => Number.isSafeInteger(id) && id > 0)
        ),
      ].slice(0, 5);
    }
  } catch {
    /* Ignore invalid preferences. */
  }
  if (!ids.length) {
    return [];
  }
  const current = db.select().from(albums).where(inArray(albums.id, ids)).all();
  return ids.flatMap((id) => {
    const album = current.find((item) => item.id === id && !item.isSmart);
    return album ? [album] : [];
  });
}

export function rememberAlbum(albumId: number, db = getDatabase()) {
  const ids = [
    albumId,
    ...getRecentAlbums(db)
      .map((album) => album.id)
      .filter((id) => id !== albumId),
  ].slice(0, 5);
  db.insert(appSettings)
    .values({ key: KEY, value: JSON.stringify(ids) })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value: JSON.stringify(ids), updatedAt: Date.now() },
    })
    .run();
}
