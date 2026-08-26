import { eq, sql } from "drizzle-orm";
import { getDatabase } from "@/db";
import { appSettings } from "@/db/schema";

export function getSetting(key: string): string | null {
  const db = getDatabase();
  const row = db
    .select()
    .from(appSettings)
    .where(eq(appSettings.key, key))
    .get();
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  const db = getDatabase();
  db.insert(appSettings)
    .values({ key, value, updatedAt: Date.now() })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value, updatedAt: Date.now() },
    })
    .run();
}

export function deleteSetting(key: string): void {
  getDatabase().delete(appSettings).where(eq(appSettings.key, key)).run();
}

export function deleteSettingsByPrefix(prefix: string): void {
  getDatabase()
    .delete(appSettings)
    .where(sql`${appSettings.key} LIKE ${`${prefix}%`}`)
    .run();
}

export function getAllSettings(
  prefix?: string
): Array<{ key: string; value: string }> {
  const db = getDatabase();
  if (prefix) {
    return db
      .select()
      .from(appSettings)
      .where(sql`${appSettings.key} LIKE ${`${prefix}%`}`)
      .all()
      .map((r) => ({ key: r.key, value: r.value }));
  }
  return db
    .select()
    .from(appSettings)
    .all()
    .map((r) => ({ key: r.key, value: r.value }));
}
