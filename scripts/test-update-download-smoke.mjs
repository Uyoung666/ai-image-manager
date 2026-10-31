import { spawn } from "node:child_process";
import path from "node:path";
import electron from "electron";
import { build } from "esbuild";
import { TestRuntime } from "../src/tests/helpers/test-runtime.ts";

const manifest = process.argv[2];
if (!manifest) {
  throw new Error(
    "Usage: node --experimental-strip-types scripts/test-update-download-smoke.mjs <published-update-manifest.json>"
  );
}
const runtime = new TestRuntime("update-download-smoke");
const entry = path.join(runtime.root, "probe.cjs");
try {
  await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: "ts",
      contents: `
        import { app } from 'electron';
        import fs from 'node:fs/promises';
        import path from 'node:path';
        import { downloadUpdatePackage, verifyUpdatePackage } from './src/services/update-download';
        import { parseUpdateManifest } from './src/services/github-update';
        app.setPath('userData', path.join(process.env.UPDATE_SMOKE_ROOT, 'profile'));
        app.whenReady().then(async () => {
          const manifest = parseUpdateManifest(JSON.parse(await fs.readFile(process.env.UPDATE_SMOKE_MANIFEST, 'utf8')));
          const info = manifest.packages.delta;
          if (!info || info.size > 32 * 1024 * 1024) throw new Error('Smoke requires a published delta under 32 MiB');
          const destination = path.join(process.env.UPDATE_SMOKE_ROOT, info.filename);
          for (const resume of [false, true]) {
            await downloadUpdatePackage(info, destination, () => {});
            if (!(await verifyUpdatePackage(destination, info))) throw new Error('Package verification failed');
            console.log(JSON.stringify({ transport: 'real-electron-production-downloader', resume, version: manifest.version, size: info.size, sha256: info.sha256, status: 'passed' }));
            if (!resume) {
              const bytes = await fs.readFile(destination);
              await fs.writeFile(destination + '.download', bytes.subarray(0, 8192));
              await fs.unlink(destination);
            }
          }
        }).then(() => app.exit(0), error => { console.error(error); app.exit(1); });
      `,
    },
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron"],
    alias: { "@": path.resolve("src") },
    outfile: entry,
  });
  const env = {
    ...process.env,
    UPDATE_SMOKE_ROOT: runtime.root,
    UPDATE_SMOKE_MANIFEST: path.resolve(manifest),
  };
  env.ELECTRON_RUN_AS_NODE = undefined;
  const child = spawn(electron, [entry], {
    env,
    stdio: "inherit",
    windowsHide: true,
  });
  runtime.trackProcess(child);
  const timer = setTimeout(() => child.kill(), 120_000);
  let code;
  try {
    code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
  } finally {
    clearTimeout(timer);
  }
  if (code !== 0) {
    throw new Error(`Real Electron update download smoke failed: ${code}`);
  }
} catch (error) {
  runtime.retain();
  console.error(`Evidence retained: ${runtime.root}`);
  throw error;
} finally {
  runtime.cleanup();
}
