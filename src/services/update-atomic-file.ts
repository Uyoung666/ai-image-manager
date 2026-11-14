import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

const REPLACE_RETRY_DELAYS = [25, 50, 100];

async function replaceMetadata(temporary: string, file: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(temporary, file);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        process.platform !== "win32" ||
        (code !== "EPERM" && code !== "EBUSY") ||
        attempt >= REPLACE_RETRY_DELAYS.length
      ) {
        throw error;
      }
      await delay(REPLACE_RETRY_DELAYS[attempt]);
    }
  }
}

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
    await replaceMetadata(temporary, file);
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
}
