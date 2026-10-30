import fs from "node:fs/promises";
import type { ShootingProjectSourceStatus } from "@/types/shooting-project";

/** Check directory access without enumerating files or updating project records. */
export async function checkSourceStatus(
  sourceRoot: string
): Promise<ShootingProjectSourceStatus> {
  try {
    const directory = await fs.opendir(sourceRoot);
    await directory.close();
    return "online";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? "offline" : "inaccessible";
  }
}
