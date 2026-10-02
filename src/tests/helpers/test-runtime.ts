import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const RUNTIME_MARKER = ".aim-test-runtime.json";
const OWNER_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PROTECTED_EXTENSION = /\.(csv|xlsx)$/i;
const DIAGNOSTIC_EXTENSION = /\.(log|jsonl|png|jpg|json)$/i;
const DAY_MS = 24 * 60 * 60 * 1000;

interface RuntimeMetadata {
  childPids: number[];
  createdAt: number;
  directory: string;
  keep: boolean;
  launchPending: boolean;
  owner: string;
  ownerPid: number;
  version: 1;
}

export interface RuntimeCleanupResult {
  reason?: string;
  root: string;
  status: "deleted" | "retained" | "skipped" | "eligible" | "failed";
}

function assertBase(base: string): void {
  if (![path.resolve(".test-runtime"), path.resolve(".cache")].includes(base)) {
    throw new Error(`Unsupported test runtime base: ${base}`);
  }
}

function assertRoot(root: string, base: string): void {
  assertBase(base);
  if (path.dirname(root) !== base) {
    throw new Error(`Test runtime path escaped its base: ${root}`);
  }
  let ancestor = root;
  while (ancestor !== path.dirname(ancestor)) {
    if (path.basename(ancestor).toLowerCase() === "temp") {
      throw new Error(`Protected Temp directory: ${ancestor}`);
    }
    if (fs.existsSync(ancestor) && fs.lstatSync(ancestor).isSymbolicLink()) {
      throw new Error(`Test runtime contains a link: ${ancestor}`);
    }
    ancestor = path.dirname(ancestor);
  }
}

function scanRuntime(root: string, base: string): string[] {
  assertRoot(root, base);
  const files: string[] = [];
  const pending = [root];
  while (pending.length) {
    const entry = pending.pop();
    if (!entry) {
      continue;
    }
    const stat = fs.lstatSync(entry);
    if (stat.isSymbolicLink()) {
      throw new Error(`Test runtime contains a link: ${entry}`);
    }
    if (stat.isDirectory()) {
      if (path.basename(entry).toLowerCase() === "temp") {
        throw new Error(`Protected Temp directory: ${entry}`);
      }
      pending.push(
        ...fs.readdirSync(entry).map((name) => path.join(entry, name))
      );
    } else {
      if (PROTECTED_EXTENSION.test(entry)) {
        throw new Error(`Protected spreadsheet: ${entry}`);
      }
      files.push(entry);
    }
  }
  return files;
}

function validPid(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function readMetadata(root: string): RuntimeMetadata {
  const marker = path.join(root, RUNTIME_MARKER);
  if (fs.lstatSync(marker).isSymbolicLink()) {
    throw new Error(`Runtime marker is a link: ${root}`);
  }
  const value = JSON.parse(fs.readFileSync(marker, "utf8"));
  if (
    value.version !== 1 ||
    typeof value.owner !== "string" ||
    !OWNER_PATTERN.test(value.owner) ||
    value.directory !== path.basename(root) ||
    !value.directory.startsWith(`${value.owner}-`) ||
    !Number.isFinite(value.createdAt) ||
    value.createdAt <= 0 ||
    !validPid(value.ownerPid) ||
    !Array.isArray(value.childPids) ||
    !value.childPids.every(validPid) ||
    typeof value.keep !== "boolean" ||
    typeof value.launchPending !== "boolean"
  ) {
    throw new Error(`Invalid test runtime marker: ${root}`);
  }
  return value;
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Access denied and unknown errors do not prove a process has exited.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export class TestRuntime {
  readonly root: string;
  readonly base: string;

  constructor(owner: string, base = path.resolve(".test-runtime")) {
    if (!OWNER_PATTERN.test(owner)) {
      throw new Error(`Invalid test runtime owner: ${owner}`);
    }
    this.base = path.resolve(base);
    assertBase(this.base);
    assertRoot(path.join(this.base, `${owner}-pending`), this.base);
    fs.mkdirSync(this.base, { recursive: true });
    this.root = fs.mkdtempSync(path.join(this.base, `${owner}-`));
    const metadata: RuntimeMetadata = {
      version: 1,
      owner,
      directory: path.basename(this.root),
      createdAt: Date.now(),
      ownerPid: process.pid,
      childPids: [],
      keep: process.env.AIM_KEEP_TEST_RUNTIME === "1",
      launchPending: false,
    };
    fs.writeFileSync(
      path.join(this.root, RUNTIME_MARKER),
      JSON.stringify(metadata)
    );
  }

  setLaunchPending(): void {
    const metadata = readMetadata(this.root);
    metadata.launchPending = true;
    this.writeMetadata(metadata);
  }

  trackProcess(child: ChildProcess): void {
    if (!child.pid) {
      throw new Error(`Test process has no PID: ${this.root}`);
    }
    const metadata = readMetadata(this.root);
    metadata.childPids = [...new Set([...metadata.childPids, child.pid])];
    metadata.launchPending = false;
    this.writeMetadata(metadata);
  }

  private writeMetadata(metadata: RuntimeMetadata): void {
    assertRoot(this.root, this.base);
    fs.writeFileSync(
      path.join(this.root, RUNTIME_MARKER),
      JSON.stringify(metadata)
    );
  }

  retain(): void {
    const metadata = readMetadata(this.root);
    metadata.keep = true;
    this.writeMetadata(metadata);
  }

  saveDiagnostics(destination: string): string[] {
    const output = path.resolve(destination);
    if (output === this.root || output.startsWith(`${this.root}${path.sep}`)) {
      throw new Error("Runtime diagnostics must be saved outside the runtime");
    }
    const files = scanRuntime(this.root, this.base);
    const saved: string[] = [];
    for (const file of files) {
      const relative = path.relative(this.root, file);
      const parts = relative.split(path.sep);
      if (
        file !== path.join(this.root, RUNTIME_MARKER) &&
        !(
          DIAGNOSTIC_EXTENSION.test(file) &&
          (parts.length === 1 ||
            parts.includes("logs") ||
            parts.includes("diagnostics"))
        )
      ) {
        continue;
      }
      const target = path.join(output, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(file, target);
      saved.push(target);
    }
    return saved;
  }

  cleanup(): RuntimeCleanupResult {
    return cleanupRuntime(this.root, this.base, true);
  }
}

function cleanupRuntime(
  root: string,
  base: string,
  ownRuntime = false
): RuntimeCleanupResult {
  assertRoot(root, base);
  if (!fs.existsSync(root)) {
    return { root, status: "deleted" };
  }
  const metadata = readMetadata(root);
  if (metadata.keep || process.env.AIM_KEEP_TEST_RUNTIME === "1") {
    return { root, status: "retained", reason: "AIM_KEEP_TEST_RUNTIME=1" };
  }
  if (metadata.launchPending) {
    return { root, status: "skipped", reason: "Unconfirmed Electron launch" };
  }
  const pids = [...metadata.childPids];
  if (!(ownRuntime && metadata.ownerPid === process.pid)) {
    pids.push(metadata.ownerPid);
  }
  if (pids.some(isProcessAlive)) {
    return {
      root,
      status: "skipped",
      reason: "A related process is still running",
    };
  }
  scanRuntime(root, base);
  const removalOptions = {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 200,
  };
  // Keep the ownership marker until all payloads have been removed. A failed
  // partial cleanup must remain identifiable by the stale-runtime command.
  for (const name of fs.readdirSync(root)) {
    if (name !== RUNTIME_MARKER) {
      fs.rmSync(path.join(root, name), removalOptions);
    }
  }
  try {
    fs.rmSync(root, removalOptions);
  } catch (error) {
    if (fs.existsSync(root)) {
      try {
        fs.writeFileSync(
          path.join(root, RUNTIME_MARKER),
          JSON.stringify(metadata)
        );
      } catch (markerError) {
        throw new AggregateError(
          [error, markerError],
          `Cleanup and marker recovery failed: ${root}`
        );
      }
    }
    throw error;
  }
  if (fs.existsSync(root)) {
    throw new Error(`Test runtime cleanup did not finish: ${root}`);
  }
  return { root, status: "deleted" };
}

function inspectStaleRuntime(
  root: string,
  base: string,
  apply: boolean
): RuntimeCleanupResult | undefined {
  try {
    if (!fs.existsSync(path.join(root, RUNTIME_MARKER))) {
      return undefined;
    }
    assertRoot(root, base);
    const metadata = readMetadata(root);
    if (Date.now() - metadata.createdAt < DAY_MS) {
      return { root, status: "skipped", reason: "Less than 24 hours old" };
    }
    if (metadata.keep || process.env.AIM_KEEP_TEST_RUNTIME === "1") {
      return { root, status: "retained", reason: "Explicitly retained" };
    }
    if (
      metadata.launchPending ||
      [metadata.ownerPid, ...metadata.childPids].some(isProcessAlive)
    ) {
      return {
        root,
        status: "skipped",
        reason: "Active or unconfirmed process",
      };
    }
    scanRuntime(root, base);
    if (!apply) {
      return { root, status: "eligible" };
    }
    try {
      return cleanupRuntime(root, base);
    } catch (error) {
      return { root, status: "failed", reason: (error as Error).message };
    }
  } catch (error) {
    return {
      root,
      status: "skipped",
      reason: (error as Error).message,
    };
  }
}

export function cleanupStaleRuntimes(apply = false): RuntimeCleanupResult[] {
  const results: RuntimeCleanupResult[] = [];
  for (const base of [path.resolve(".test-runtime"), path.resolve(".cache")]) {
    assertRoot(path.join(base, "scan"), base);
    if (!fs.existsSync(base)) {
      continue;
    }
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (!(entry.isDirectory() || entry.isSymbolicLink())) {
        continue;
      }
      const result = inspectStaleRuntime(
        path.join(base, entry.name),
        base,
        apply
      );
      if (result) {
        results.push(result);
      }
    }
  }
  return results;
}
