import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const LINE_SPLIT_RE = /\r?\n/;

export const RUNTIME_SOURCE_PATHS = [
  "src",
  "scripts",
  "drizzle",
  "package.json",
  "package-lock.json",
  "forge.config.ts",
  "vite.main.config.mts",
  "vite.preload.config.mts",
  "vite.renderer.config.mts",
];

function collectFiles(root, relative, files) {
  const entry = path.join(root, relative);
  if (!fs.existsSync(entry)) {
    return;
  }
  if (fs.statSync(entry).isDirectory()) {
    for (const name of fs.readdirSync(entry).sort()) {
      collectFiles(root, path.join(relative, name), files);
    }
  } else {
    files.push(relative.replaceAll("\\", "/"));
  }
}

export function runtimeSourceFiles(root) {
  const files = [];
  for (const relative of RUNTIME_SOURCE_PATHS) {
    collectFiles(root, relative, files);
  }
  const modelFiles = [];
  collectFiles(root, "models", modelFiles);
  return files
    .concat(modelFiles.filter((file) => !file.endsWith(".onnx")))
    .sort();
}

export function hashRuntimeSourceTree(root) {
  const hash = createHash("sha256");
  for (const relative of runtimeSourceFiles(root)) {
    const data = fs.readFileSync(path.join(root, relative));
    hash.update(`${relative}\0${data.length}\0`).update(data);
  }
  return hash.digest("hex");
}

export function copyRuntimeSources(root, destination) {
  const files = runtimeSourceFiles(root);
  for (const relative of files) {
    const target = path.join(destination, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(root, relative), target);
  }
  return files;
}

export function fingerprintModelArtifacts(root) {
  const files = [];
  collectFiles(root, "models", files);
  const buffer = Buffer.alloc(1024 * 1024);
  return files
    .filter((file) => file.endsWith(".onnx"))
    .map((file) => {
      const hash = createHash("sha256");
      const descriptor = fs.openSync(path.join(root, file), "r");
      let size = 0;
      try {
        for (;;) {
          const read = fs.readSync(descriptor, buffer, 0, buffer.length, null);
          if (!read) {
            break;
          }
          size += read;
          hash.update(buffer.subarray(0, read));
        }
      } finally {
        fs.closeSync(descriptor);
      }
      return { file, size, sha256: hash.digest("hex") };
    });
}

/** Expose shared weights at the frozen model path without replacing configs. */
export function linkSharedModelArtifacts(root, destination) {
  const files = [];
  collectFiles(root, "models", files);
  for (const relative of files.filter((file) => file.endsWith(".onnx"))) {
    const source = path.join(root, relative);
    const target = path.join(destination, relative);
    if (fs.existsSync(target)) {
      const sourceStat = fs.statSync(source);
      const targetStat = fs.statSync(target);
      if (
        sourceStat.dev !== targetStat.dev ||
        sourceStat.ino !== targetStat.ino
      ) {
        throw new Error(`Frozen model artifact already exists: ${relative}`);
      }
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.linkSync(source, target);
  }
}

/** Models remain shared read-only resources, with their configs frozen. */
export function freezeWorkspace(repo, destination) {
  fs.mkdirSync(destination, { recursive: false });
  const files = copyRuntimeSources(repo, destination);
  const metadata = {
    schemaVersion: 2,
    kind: "workspace",
    sourceTreeHash: hashRuntimeSourceTree(destination),
    files,
    modelResources: "shared-local-artifacts-with-frozen-configs",
  };
  fs.writeFileSync(
    path.join(destination, "source.json"),
    JSON.stringify(metadata, null, 2)
  );
  return metadata;
}

export function hashSourceTree(source) {
  const hash = createHash("sha256");
  function visit(directory) {
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name);
      if (fs.statSync(file).isDirectory()) {
        visit(file);
      } else {
        const relative = path.relative(source, file).replaceAll("\\", "/");
        const data = fs.readFileSync(file);
        hash.update(`${relative}\0${data.length}\0`).update(data);
      }
    }
  }
  visit(source);
  return hash.digest("hex");
}

/** Freeze committed sources without touching the user's index or checkout. */
export function freezeHead(repo, destination) {
  return freezeRevision(repo, destination, "HEAD");
}

/** Resolve a commit before archiving; never switch or reset the checkout. */
export function freezeRevision(repo, destination, ref) {
  const reports = path.resolve(repo, "reports/search-optimization");
  if (!path.resolve(destination).startsWith(reports + path.sep)) {
    throw new Error("HEAD snapshots must stay in isolated reports");
  }
  fs.mkdirSync(destination, { recursive: false });
  const head = spawnSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
    cwd: repo,
    encoding: "utf8",
  });
  if (head.error || head.status !== 0) {
    throw new Error("Could not resolve HEAD");
  }
  const commit = head.stdout.trim();
  const tree = spawnSync("git", ["ls-tree", "--name-only", commit], {
    cwd: repo,
    encoding: "utf8",
  });
  if (tree.error || tree.status !== 0) {
    throw new Error("Could not enumerate HEAD sources");
  }
  const present = new Set(tree.stdout.trim().split(LINE_SPLIT_RE));
  const archive = spawnSync(
    "git",
    [
      "archive",
      commit,
      ...RUNTIME_SOURCE_PATHS.filter((file) => present.has(file)),
    ],
    {
      cwd: repo,
      maxBuffer: 64 * 1024 * 1024,
    }
  );
  if (archive.error || archive.status !== 0) {
    throw new Error("Could not archive committed sources");
  }
  const extracted = spawnSync("tar", ["-xf", "-", "-C", destination], {
    cwd: repo,
    input: archive.stdout,
  });
  if (extracted.error || extracted.status !== 0) {
    throw new Error("Could not extract HEAD snapshot");
  }
  // Ignored models are shared local resources, not historical Git artifacts.
  for (const relative of runtimeSourceFiles(repo).filter((file) =>
    file.startsWith("models/")
  )) {
    const target = path.join(destination, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(repo, relative), target);
  }
  const metadata = {
    schemaVersion: 2,
    kind: ref === "HEAD" ? "git-head" : "git-revision",
    requestedRef: ref,
    commit,
    sourceTreeHash: hashRuntimeSourceTree(destination),
    files: runtimeSourceFiles(destination),
    modelResources: "shared-local-artifacts-with-frozen-configs",
  };
  fs.writeFileSync(
    path.join(destination, "source.json"),
    JSON.stringify(metadata, null, 2)
  );
  return metadata;
}
