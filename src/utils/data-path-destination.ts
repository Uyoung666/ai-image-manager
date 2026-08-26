import fs from "node:fs";
import path from "node:path";

export const DATA_PATH_SUBDIRECTORIES = [
  "data",
  "models",
  "thumbnails",
  "vectors",
] as const;

export type DataPathDestination =
  | { kind: "available" }
  | { databasePath: string; kind: "existing-library" }
  | { conflictingDirectory: string; kind: "conflict" };

/**
 * Distinguish an existing AI Image Manager library from an unrelated,
 * non-empty destination. Existing libraries are safe to connect to directly;
 * other managed subdirectories must still be rejected to prevent merging data.
 */
export function inspectDataPathDestination(
  destinationPath: string
): DataPathDestination {
  const databasePath = path.join(
    destinationPath,
    "data",
    "ai-image-manager.db"
  );

  try {
    if (fs.statSync(databasePath).isFile()) {
      return { kind: "existing-library", databasePath };
    }
  } catch {
    // A missing or unreadable database is not a valid existing library.
  }

  for (const directory of DATA_PATH_SUBDIRECTORIES) {
    if (fs.existsSync(path.join(destinationPath, directory))) {
      return { kind: "conflict", conflictingDirectory: directory };
    }
  }

  return { kind: "available" };
}
