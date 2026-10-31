import fs from "node:fs";

/** Exercise preview reuse independently of the filesystem's timestamp resolution. */
export async function makePreviewNewerThanSource(
  sourcePath: string,
  previewPath: string
): Promise<void> {
  const source = await fs.promises.stat(sourcePath);
  const preview = await fs.promises.stat(previewPath);
  const newer = new Date(
    Math.ceil(
      Math.max(
        source.mtimeMs,
        source.ctimeMs,
        source.birthtimeMs,
        preview.mtimeMs
      )
    ) + 1000
  );
  await fs.promises.utimes(previewPath, preview.atime, newer);
}
