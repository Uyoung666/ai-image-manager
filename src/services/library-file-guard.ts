import fs from "node:fs";
import type { photos } from "@/db/schema";

type Source = Pick<
  typeof photos.$inferSelect,
  "path" | "sourceSize" | "sourceMtimeMs" | "sourceCtimeMs"
>;

/** Validate again at the file-operation boundary, including legacy entries. */
export function assertLibraryFileReady(photo: Source): fs.Stats {
  const stat = fs.statSync(photo.path);
  fs.accessSync(photo.path, fs.constants.R_OK);
  if (!stat.isFile()) {
    throw new Error("LIBRARY_SOURCE_UNAVAILABLE");
  }
  if (
    photo.sourceSize !== null &&
    (stat.size !== photo.sourceSize ||
      stat.mtimeMs !== photo.sourceMtimeMs ||
      stat.ctimeMs !== photo.sourceCtimeMs)
  ) {
    throw new Error("LIBRARY_SOURCE_CHANGED");
  }
  return stat;
}
