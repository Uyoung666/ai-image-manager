import fs from "node:fs";
import path from "node:path";

const LOG_LINES = /\r?\n/;

export function inspectBackgroundLog(text, launchedAt, expectedCount) {
  const rows = text.split(LOG_LINES).flatMap((line) => {
    try {
      const row = JSON.parse(line);
      return Date.parse(row.time ?? row.timestamp) >= launchedAt ? [row] : [];
    } catch {
      return [];
    }
  });
  const scans = rows.filter((row) => row.msg === "Import performance summary");
  return {
    modelInitializationComplete: rows.some(
      (row) => row.msg === "All services started"
    ),
    scans,
    scansComplete:
      scans.some((row) => row.scanned === expectedCount) &&
      scans.every((row) => row.failed === 0 && row.scanned === expectedCount),
  };
}

export async function waitForBackgroundIdle(app, options) {
  const startedAt = Date.now();
  let quietSince;
  let previousEvidence;
  let latest;
  while (Date.now() - startedAt < 120_000) {
    const queue = await app.evaluate(({ app: host }) => {
      if (globalThis.__galleryQueueRead) {
        return globalThis.__galleryQueueRead();
      }
      const fs = process.getBuiltinModule("node:fs");
      const path = process.getBuiltinModule("node:path");
      const directory = path.join(host.getAppPath(), ".vite/build/chunks");
      function findQueueModules() {
        const reachable = new Set();
        const pending = [
          path.join(host.getAppPath(), ".vite/build/bootstrap.js"),
        ];
        while (pending.length) {
          const file = pending.pop();
          if (reachable.has(file)) {
            continue;
          }
          reachable.add(file);
          const source = fs.readFileSync(file, "utf8");
          for (const match of source.matchAll(/["'](\.\.?\/[^"']+\.js)["']/g)) {
            const dependency = path.resolve(path.dirname(file), match[1]);
            if (fs.existsSync(dependency)) {
              pending.push(dependency);
            }
          }
        }
        return [...reachable].filter(
          (file) =>
            path.dirname(file) === directory &&
            path.basename(file).startsWith("import-queue-")
        );
      }
      const names = findQueueModules();
      if (names.length !== 1) {
        throw new Error("Ambiguous queue probe module");
      }
      const require = process
        .getBuiltinModule("node:module")
        .createRequire(path.join(host.getAppPath(), "package.json"));
      const module = require(names[0]);
      globalThis.__galleryQueueRead = () => ({
        ...module.getImportQueueStatus(),
        events: globalThis.__galleryQueueEvents ?? [],
      });
      return globalThis.__galleryQueueRead();
    });
    const logPath = path.join(options.profile, "logs/app.log");
    const log = inspectBackgroundLog(
      fs.readFileSync(logPath, "utf8"),
      options.launchedAt,
      options.count
    );
    const evidence = JSON.stringify({ queue, log });
    const idle =
      !queue.current &&
      queue.pending.length === 0 &&
      log.modelInitializationComplete &&
      log.scansComplete;
    if (!idle || evidence !== previousEvidence) {
      quietSince = undefined;
    }
    if (idle) {
      quietSince ??= Date.now();
    }
    previousEvidence = evidence;
    latest = { ...log, queue, observedAt: Date.now(), quietSince };
    if (quietSince !== undefined && Date.now() - quietSince >= 2000) {
      return { ...latest, startedAt, waitMs: Date.now() - startedAt };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  fs.writeFileSync(
    options.failurePath,
    JSON.stringify({ startedAt, latest }, null, 2)
  );
  throw new Error(
    "Background did not finish within 120 seconds; see idle failure report"
  );
}
