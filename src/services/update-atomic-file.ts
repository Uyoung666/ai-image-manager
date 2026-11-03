import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";

/** The old metadata remains readable if writing or replacing the new file fails. */
export async function writeUpdateMetadata(
  file: string,
  content: string
): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temporary, "wx");
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, file);
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
}
