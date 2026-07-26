import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const rawPreviewRequire = createRequire(import.meta.url);
const exiftoolPath = rawPreviewRequire("exiftool-vendored.exe");
const EXIFTOOL_UTF8_ARGS = ["-charset", "filename=UTF8", "-@", "-"];

export function buildExiftoolArgFile(tag, filePath) {
  return Buffer.from(`-b\n-${tag}\n${filePath}\n`, "utf8");
}

export function extractRawPreview(filePath, runExiftool = execFileSync) {
  for (const tag of ["JpgFromRaw", "PreviewImage"]) {
    try {
      const buf = runExiftool(exiftoolPath, EXIFTOOL_UTF8_ARGS, {
        input: buildExiftoolArgFile(tag, filePath),
        timeout: 15_000,
        maxBuffer: 50 * 1024 * 1024,
      });
      if (buf && buf.length > 0) {
        return buf;
      }
    } catch {
      // The tag may not exist for this RAW format.
    }
  }
  return null;
}
