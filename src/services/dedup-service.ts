import { eq } from "drizzle-orm";
import { getDatabase } from "@/db";
import { duplicateCleanupPlans } from "@/db/schema";
import { setSetting } from "./settings-manager";

export function checkNewPhotoDuplicates(
  _photoId: number,
  _phash: string | null,
  _filePath: string,
  _fileSize: number,
  _threshold = 8
): void {
  // Import-time detection only invalidates the authoritative scan. It must not
  // publish an executable pair using a different verification path than the
  // full scan; the duplicate page will run the shared staged detector.
  setSetting("duplicates.scannedSignature", "");
  getDatabase()
    .update(duplicateCleanupPlans)
    .set({ status: "STALE", updatedAt: Date.now() })
    .where(eq(duplicateCleanupPlans.status, "READY"))
    .run();
}
