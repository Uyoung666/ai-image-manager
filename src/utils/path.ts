import path from "node:path";
import { fileURLToPath } from "node:url";

export function getBasePath() {
  return path.dirname(fileURLToPath(import.meta.url));
}
