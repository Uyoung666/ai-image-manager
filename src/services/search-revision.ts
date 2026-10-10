import { sql } from "drizzle-orm";
import type { getDatabase } from "@/db";

let vectorRevision = 0;
let nextDatabaseId = 0;
const databaseIds = new WeakMap<object, number>();

export function invalidateVectorSearch(): void {
  vectorRevision++;
}
export function getVectorSearchRevision(): number {
  return vectorRevision;
}

/** Search-field triggers advance this revision in the writer's transaction. */
export function getSearchDatabaseRevision(
  db: ReturnType<typeof getDatabase>,
  includeVectors = true
): string {
  let id = databaseIds.get(db);
  if (id === undefined) {
    id = ++nextDatabaseId;
    databaseIds.set(db, id);
  }
  const row = db.get<{ revision: number }>(
    sql`SELECT revision FROM search_data_revision WHERE id = 1`
  );
  const metadataRevision = `${id}:${row?.revision ?? 0}`;
  return includeVectors
    ? `${metadataRevision}:${vectorRevision}`
    : metadataRevision;
}
