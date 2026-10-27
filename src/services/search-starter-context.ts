import { sql } from "drizzle-orm";
import type { getDatabase } from "@/db";
import { getActiveEmbeddingFingerprint } from "@/services/ai/model-fingerprint";
import { getActiveSearchSensitivity } from "@/services/ai/search-sensitivity";
import { getSemanticSearchThresholdIdentity } from "@/services/ai/threshold-profile";
import { getStarterPreferenceRevision } from "@/services/search-background";
import { getSearchDatabaseRevision } from "@/services/search-revision";
import { localSearchDay } from "./search-starter-candidates";

export function getSearchStarterContext(db: ReturnType<typeof getDatabase>) {
  const gallery = db.get<{ revision: number }>(
    sql`SELECT revision FROM gallery_data_revision WHERE id = 1`
  );
  const metadataRevision = JSON.stringify([
    getSearchDatabaseRevision(db, false),
    gallery?.revision ?? 0,
  ]);
  const validity = JSON.stringify([
    metadataRevision,
    getSearchDatabaseRevision(db),
    getActiveEmbeddingFingerprint(),
    getSemanticSearchThresholdIdentity(),
    getActiveSearchSensitivity(),
  ]);
  return {
    day: localSearchDay(),
    metadataRevision,
    revision: JSON.stringify([validity, getStarterPreferenceRevision()]),
    validity,
  };
}
