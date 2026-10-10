import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Refuse links in the input path as well as in the copied artifact tree. */
export function assertPlainDirectory(directory) {
  const resolved = path.resolve(directory);
  let ancestor = resolved;
  for (;;) {
    const stat = fs.lstatSync(ancestor);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(
        `Renderer path must use ordinary directories: ${ancestor}`
      );
    }
    const parent = path.dirname(ancestor);
    if (parent === ancestor) {
      break;
    }
    ancestor = parent;
  }
  return resolved;
}

export function resolveComparisonRendererSources(args, currentRenderer) {
  if (
    args.length !== 0 &&
    (args.length !== 2 || args[0] !== "--baseline-renderer" || !args[1])
  ) {
    throw new Error(
      "Expected optional --baseline-renderer <built renderer directory>"
    );
  }
  return {
    baseline: assertPlainDirectory(args[1] ?? currentRenderer),
    optimized: assertPlainDirectory(currentRenderer),
  };
}

/** Hash every built artifact, including assets referenced by JS or CSS. */
export function fingerprintRendererArtifacts(directory) {
  const root = assertPlainDirectory(directory);
  const files = [];
  const hash = createHash("sha256");
  function visit(relative) {
    const absolute = path.join(root, relative);
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      throw new Error(`Renderer artifacts must not contain links: ${absolute}`);
    }
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(absolute).sort()) {
        visit(path.join(relative, name));
      }
      return;
    }
    if (!stat.isFile()) {
      throw new Error(`Renderer artifact is not a regular file: ${absolute}`);
    }
    const data = fs.readFileSync(absolute);
    const file = relative.replaceAll("\\", "/");
    files.push({
      file,
      size: data.length,
      sha256: createHash("sha256").update(data).digest("hex"),
    });
    hash.update(`${file}\0${data.length}\0`).update(data);
  }
  visit("");
  const entry = files.find((file) => file.file === "main_window/index.html");
  if (!entry) {
    throw new Error(`Built renderer entry is missing: ${root}`);
  }
  return { files, sha256: hash.digest("hex"), entrySha256: entry.sha256 };
}

export function copyRendererArtifacts(source, destination, expected) {
  const sourceRoot = path.resolve(source);
  const targetRoot = path.resolve(destination);
  const inside = (candidate, root) => {
    const relative = path.relative(root, candidate);
    return (
      relative === "" ||
      (relative !== ".." &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative))
    );
  };
  if (inside(targetRoot, sourceRoot) || inside(sourceRoot, targetRoot)) {
    throw new Error("Renderer input and output must not overlap");
  }
  const before = fingerprintRendererArtifacts(source);
  if (before.sha256 !== expected.sha256) {
    throw new Error(`Renderer source changed before copying: ${source}`);
  }
  assertPlainDirectory(path.dirname(destination));
  if (fs.lstatSync(destination, { throwIfNoEntry: false })) {
    throw new Error(`Renderer output already exists: ${destination}`);
  }
  fs.cpSync(source, destination, { recursive: true });
  const copied = fingerprintRendererArtifacts(destination);
  const after = fingerprintRendererArtifacts(source);
  if (copied.sha256 !== expected.sha256 || after.sha256 !== expected.sha256) {
    throw new Error(`Renderer artifacts changed during copying: ${source}`);
  }
  return copied;
}
