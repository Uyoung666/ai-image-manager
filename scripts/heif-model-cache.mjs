import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

export const HEIF_MODEL_CACHE_PATTERN = /^h-[a-f0-9]{32}-[a-f0-9]{32}\.png$/;
const digest = (value) => createHash("md5").update(value).digest("hex");
export function heifSourcePrefix(input) {
  const resolved = path.resolve(input);
  return `h-${digest(process.platform === "win32" ? resolved.toLowerCase() : resolved)}-`;
}
function epoch(dir) {
  return fs.readFile(path.join(dir, ".heif-epoch"), "utf8").catch(() => "0");
}
export async function invalidateHeifModelCache(dir) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, ".heif-epoch"), randomUUID());
}
export async function describeHeifModelCache(input, image, dir) {
  if (typeof input !== "string" || !dir) {
    return null;
  }
  try {
    const stat = await fs.stat(input);
    const generation = await epoch(dir);
    const spec = Object.fromEntries(
      Object.keys(image)
        .sort()
        .map((key) => [key, image[key]])
    );
    const identity = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:heif-rgb-v1:${JSON.stringify(spec)}:${generation}`;
    return {
      file: path.join(dir, `${heifSourcePrefix(input)}${digest(identity)}.png`),
      identity,
      generation,
      dir,
      input,
      image,
    };
  } catch {
    return null;
  }
}
export async function readHeifModelCache(descriptor) {
  if (!descriptor) {
    return null;
  }
  try {
    const size = descriptor.image.imageSize;
    const stat = await fs.stat(descriptor.file);
    if (stat.size > size * size * 4 + 65_536) {
      return null;
    }
    const data = await fs.readFile(descriptor.file);
    const decoded = await sharp(data, { limitInputPixels: size * size })
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (
      decoded.info.width !== size ||
      decoded.info.height !== size ||
      decoded.info.channels !== 3
    ) {
      return null;
    }
    const current = await describeHeifModelCache(
      descriptor.input,
      descriptor.image,
      descriptor.dir
    );
    return current?.identity === descriptor.identity ? decoded.data : null;
  } catch {
    return null;
  }
}
export async function writeHeifModelCache(descriptor, png) {
  if (!(descriptor && png)) {
    return;
  }
  const temporary = `${descriptor.file}.${randomUUID()}.tmp`;
  try {
    const current = await describeHeifModelCache(
      descriptor.input,
      descriptor.image,
      descriptor.dir
    );
    if (current?.identity !== descriptor.identity) {
      return;
    }
    await fs.mkdir(descriptor.dir, { recursive: true });
    await fs.writeFile(temporary, png, { flag: "wx" });
    const latest = await describeHeifModelCache(
      descriptor.input,
      descriptor.image,
      descriptor.dir
    );
    if (latest?.identity !== descriptor.identity) {
      return;
    }
    await fs.rename(temporary, descriptor.file);
    if ((await epoch(descriptor.dir)) !== descriptor.generation) {
      await fs.unlink(descriptor.file).catch(() => undefined);
    }
  } catch {
    /* Derived cache failures must never fail import/inference. */
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
}
