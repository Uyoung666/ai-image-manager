// Isolated Windows integration fixture. Bundles the production updater without
// changing its routing/state machine. Only settings, diagnostics and network
// destinations are supplied by this harness; Update.exe and relaunch are real.
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { chromium } from "@playwright/test";
import { build } from "vite";

const root = path.resolve(".test-runtime", `updater-install-${Date.now()}`);
await fsp.mkdir(root, { recursive: true });
const versions = ["2.2.3", "2.2.4"];
const id = "aim-update-verification";
const RANGE_REQUEST = /^bytes=(\d+)-$/;
const vendor = path.resolve("node_modules/electron-winstaller/vendor");
const feed = path.join(root, "feed");
await fsp.mkdir(feed);
const releasedBaseline = process.argv.includes("--released-baseline");
const trace = [
  {
    baseline: releasedBaseline ? "v2.2.3" : "working-tree",
    target: "working-tree",
  },
];
function run(exe, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, {
      windowsHide: true,
      cwd: root,
      ...options,
    });
    let output = "";
    child.stdout?.on("data", (chunk) => {
      output = `${output}${chunk}`.slice(-12_000);
    });
    child.stderr?.on("data", (chunk) => {
      output = `${output}${chunk}`.slice(-12_000);
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolve(output)
        : reject(new Error(`${path.basename(exe)} exited ${code}: ${output}`))
    );
  });
}
async function waitFor(callback, label, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const value = await callback();
      if (value) {
        return value;
      }
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) {
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out: ${label}`);
}
const settings = path.join(root, "settings.ts");
const logging = path.join(root, "logging.ts");
await fsp.writeFile(
  settings,
  'export function getSetting() { return "true"; }'
);
await fsp.writeFile(
  logging,
  `import fs from 'node:fs'; import path from 'node:path'; import {app} from 'electron'; export function appendDiagnosticLog(record) { fs.mkdirSync(app.getPath('userData'),{recursive:true}); fs.appendFileSync(path.join(app.getPath('userData'),'updater.log'),JSON.stringify(record)+'\\n'); }`
);
const entry = path.join(root, "main.ts");
await fsp.writeFile(
  entry,
  `
import fs from 'node:fs'; import path from 'node:path';
import {app, BrowserWindow, ipcMain, net} from 'electron';
import {startUpdateManager, checkForUpdatesManually, installUpdate} from '@/services/update-manager';
import {getUpdateState} from '@/services/update-state';
if(process.argv.some(a=>a.startsWith('--squirrel-'))) { app.quit(); }
else {
 app.setPath('userData',process.env.AIM_FIXTURE_PROFILE);
 const originalRequest=net.request.bind(net), originalFetch=net.fetch.bind(net);
 const map=(url)=>String(url).startsWith(process.env.AIM_FIXTURE_SERVER+'/')?String(url):process.env.AIM_FIXTURE_SERVER+'/'+encodeURIComponent(String(url));
 net.request=(options)=>originalRequest({...options,url:map(options.url)});
 net.fetch=(url,options)=>originalFetch(map(url),options);
 ipcMain.handle('fixture:install',()=>installUpdate());
 app.whenReady().then(async()=>{
   const win=new BrowserWindow({width:720,height:480,show:false,webPreferences:{nodeIntegration:true,contextIsolation:false}});
   await win.loadURL('data:text/html,<button id="install">Install</button><script>document.querySelector("button").onclick=()=>require("electron").ipcRenderer.invoke("fixture:install")</script>');
   startUpdateManager();
   fs.writeFileSync(path.join(app.getPath('userData'),'launched-'+app.getVersion()+'.json'),JSON.stringify({version:app.getVersion(),path:process.execPath,pid:process.pid,status:getUpdateState()}));
   if(app.getVersion()==='2.2.3') checkForUpdatesManually();
 });
}
`
);
const compiled = path.join(root, "compiled");
const buildConfig = {
  configFile: false,
  resolve: {
    alias: [
      { find: "@/services/settings-manager", replacement: settings },
      { find: "@/services/diagnostics/logging", replacement: logging },
      { find: "@", replacement: path.resolve("src") },
    ],
  },
  define: {
    __AIM_UPDATE_BASE_URL__: JSON.stringify(
      "https://github.com/Uyoung666/ai-image-manager/releases"
    ),
  },
  build: {
    outDir: compiled,
    ssr: true,
    target: "node22",
    minify: false,
    lib: { entry, formats: ["es"], fileName: "main" },
    rollupOptions: {
      external: [/^node:/, "electron"],
      output: { entryFileNames: "main.mjs" },
    },
  },
  ssr: { noExternal: true },
};
await build(structuredClone(buildConfig));
await fsp.writeFile(
  path.join(compiled, "bootstrap.cjs"),
  `const fs=require('node:fs');const path=require('node:path');const fail=e=>{fs.appendFileSync(path.join(process.env.AIM_FIXTURE_PROFILE,'fatal.log'),String(e.stack||e)+'\\n');require('electron').app.exit(1);};process.on('uncaughtException',fail);import('./main.mjs').catch(fail);`
);

let baselineCompiled = compiled;
if (releasedBaseline) {
  baselineCompiled = path.join(root, "compiled-released-baseline");
  const aliases = [];
  for (const name of [
    "services/update-manager",
    "services/update-state",
    "services/github-update",
    "services/update-error",
    "utils/update-error",
    "types/app-preferences",
    "types/update",
  ]) {
    const destination = path.join(root, `${name.replaceAll("/", "-")}.ts`);
    await fsp.writeFile(
      destination,
      execFileSync("git", ["show", `v2.2.3:src/${name}.ts`], {
        windowsHide: true,
        maxBuffer: 2 * 1024 * 1024,
      })
    );
    aliases.push({ find: `@/${name}`, replacement: destination });
  }
  await build(
    structuredClone({
      ...buildConfig,
      resolve: { alias: [...aliases, ...buildConfig.resolve.alias] },
      build: { ...buildConfig.build, outDir: baselineCompiled },
    })
  );
  await fsp.copyFile(
    path.join(compiled, "bootstrap.cjs"),
    path.join(baselineCompiled, "bootstrap.cjs")
  );
}

for (const version of versions) {
  const appDir = path.join(root, `payload-${version}`);
  await fsp.cp(path.resolve("node_modules/electron/dist"), appDir, {
    recursive: true,
  });
  await fsp.rename(
    path.join(appDir, "electron.exe"),
    path.join(appDir, `${id}.exe`)
  );
  const resource = path.join(appDir, "resources", "app");
  await fsp.mkdir(resource, { recursive: true });
  await fsp.cp(
    version === versions[0] ? baselineCompiled : compiled,
    resource,
    { recursive: true }
  );
  await fsp.writeFile(
    path.join(resource, "package.json"),
    JSON.stringify({
      name: id,
      productName: "Update Verification",
      version,
      type: "module",
      main: "bootstrap.cjs",
    })
  );
  const spec = path.join(root, `${version}.nuspec`);
  await fsp.writeFile(
    spec,
    `<?xml version="1.0"?><package><metadata><id>${id}</id><version>${version}</version><authors>Local verification</authors><description>Isolated updater validation</description></metadata><files><file src="**" target="lib\\net45" /></files></package>`
  );
  console.log(`Packaging updater fixture ${version}`);
  await run(path.join(vendor, "nuget.exe"), [
    "pack",
    spec,
    "-BasePath",
    appDir,
    "-OutputDirectory",
    root,
    "-NoDefaultExcludes",
  ]);
  await run(path.join(vendor, "Squirrel.exe"), [
    "--releasify",
    path.join(root, `${id}.${version}.nupkg`),
    "--releaseDir",
    feed,
    "--no-msi",
  ]);
}

const packageInfo = async (version, method) => {
  const filename = `${id}-${version}-${method}.nupkg`;
  const bytes = await fsp.readFile(path.join(feed, filename));
  return {
    filename,
    size: bytes.length,
    sha1: createHash("sha1").update(bytes).digest("hex"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    url: `https://github.com/Uyoung666/ai-image-manager/releases/download/v${version}/${filename}`,
    ...(method === "delta"
      ? { fromVersion: versions[0], toVersion: version }
      : {}),
  };
};
const full = await packageInfo(versions[1], "full");
const delta = await packageInfo(versions[1], "delta");
const baseline = await packageInfo(versions[0], "full");
if (delta.size >= full.size) {
  throw new Error("Fixture must exercise delta selection");
}
let mode = "delta";
const server = createServer(async (request, response) => {
  try {
    const remote = new URL(decodeURIComponent(request.url.slice(1)));
    const filename = path.basename(remote.pathname);
    trace.push({
      method: mode,
      url: remote.toString(),
      range: request.headers.range,
    });
    if (remote.hostname === "api.github.com") {
      response.end(JSON.stringify([{ tag_name: "v2.2.4" }]));
      return;
    }
    if (filename === "update-manifest.json") {
      response.end(
        JSON.stringify({
          schemaVersion: 1,
          repository: "Uyoung666/ai-image-manager",
          platform: "win32-x64",
          version: "2.2.4",
          tag: "v2.2.4",
          assetsBaseUrl:
            "https://github.com/Uyoung666/ai-image-manager/releases/download/v2.2.4",
          releaseUrl:
            "https://github.com/Uyoung666/ai-image-manager/releases/tag/v2.2.4",
          packages: { full, ...(mode === "delta" ? { delta } : {}) },
        })
      );
      return;
    }
    if (![full.filename, delta.filename].includes(filename)) {
      response.writeHead(404).end();
      return;
    }
    const file = path.join(feed, filename);
    const size = (await fsp.stat(file)).size;
    const offset = Number(
      request.headers.range?.match(RANGE_REQUEST)?.[1] ?? 0
    );
    response.writeHead(offset ? 206 : 200, {
      "content-length": size - offset,
      ...(offset
        ? { "content-range": `bytes ${offset}-${size - 1}/${size}` }
        : {}),
    });
    const body = fs.createReadStream(file, { start: offset });
    response.on("close", () => body.destroy());
    body.pipe(response);
  } catch {
    response.writeHead(500).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const serverURL = `http://127.0.0.1:${server.address().port}`;
try {
  for (const installer of ["squirrel", "msi"]) {
    for (const method of ["delta", "full"]) {
      mode = method;
      const installRoot = path.join(root, `${installer}-${method}`);
      const profile = path.join(root, `${installer}-${method}-profile`);
      await fsp.mkdir(profile);
      await fsp.mkdir(path.join(installRoot, "packages"), { recursive: true });
      await fsp.cp(
        path.join(root, "payload-2.2.3"),
        path.join(installRoot, "app-2.2.3"),
        { recursive: true }
      );
      await fsp.copyFile(
        path.join(feed, baseline.filename),
        path.join(installRoot, "packages", baseline.filename)
      );
      await fsp.writeFile(
        path.join(installRoot, "packages", "RELEASES"),
        `${baseline.sha1} ${baseline.filename} ${baseline.size}\n`
      );
      await fsp.copyFile(
        installer === "msi"
          ? path.resolve("node_modules/electron-wix-msi/vendor/msq.exe")
          : path.join(vendor, "Squirrel.exe"),
        path.join(installRoot, "Update.exe")
      );
      if (installer === "msi") {
        // Read the installed product's auto-update policy only. A fresh random
        // productCode ensures this fixture cannot update its uninstall record.
        await fsp.writeFile(
          path.join(installRoot, ".installInfo.json"),
          JSON.stringify({
            manufacturer: "Uyoung",
            appName: "AIImageManager",
            productCode: randomUUID(),
            arch: "x86",
            installVersion: "2.2.3",
          })
        );
      }
      const debugPort =
        19_400 + (installer === "msi" ? 2 : 0) + (method === "full" ? 1 : 0);
      const child = spawn(
        path.join(installRoot, "app-2.2.3", `${id}.exe`),
        [
          `--remote-debugging-port=${debugPort}`,
          "--remote-debugging-address=127.0.0.1",
        ],
        {
          env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: undefined,
            AIM_FIXTURE_PROFILE: profile,
            AIM_FIXTURE_SERVER: serverURL,
          },
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        }
      );
      const output = fs.createWriteStream(path.join(profile, "process.log"));
      child.stdout.pipe(output, { end: false });
      child.stderr.pipe(output, { end: false });
      child.once("exit", (code) => output.end(`\nExit: ${code}\n`));
      let browser;
      let targetPid;
      try {
        await waitFor(async () => {
          if (child.exitCode !== null) {
            throw new Error(`Fixture exited ${child.exitCode}; see ${profile}`);
          }
          const state = JSON.parse(
            await fsp.readFile(path.join(profile, "update-state.json"), "utf8")
          ).state;
          if (state.phase === "error") {
            throw new Error(JSON.stringify(state));
          }
          return state.phase === "downloaded" && state.updateMethod === method;
        }, `${installer} ${method} downloaded`);
        browser = await chromium.connectOverCDP(
          `http://127.0.0.1:${debugPort}`
        );
        await browser.contexts()[0].pages()[0].locator("#install").click();
        const target = await waitFor(
          async () => {
            const state = JSON.parse(
              await fsp.readFile(
                path.join(profile, "update-state.json"),
                "utf8"
              )
            ).state;
            if (state.phase === "error") {
              throw new Error(`Install failed: ${JSON.stringify(state)}`);
            }
            return JSON.parse(
              await fsp.readFile(
                path.join(profile, "launched-2.2.4.json"),
                "utf8"
              )
            );
          },
          `${installer} ${method} target started`,
          180_000
        );
        targetPid = target.pid;
        if (
          target.status.phase !== "idle" ||
          path.basename(path.dirname(target.path)) !== "app-2.2.4"
        ) {
          throw new Error(
            `Invalid target acknowledgement: ${JSON.stringify(target)}`
          );
        }
        trace.push({ installer, method, result: "passed", target });
        console.log(
          `PASS ${installer} ${method}: ${target.version}, ${target.status.phase}`
        );
      } finally {
        await browser?.close().catch(() => undefined);
        for (const pid of [child.pid, targetPid].filter(Boolean)) {
          await run("taskkill.exe", ["/PID", String(pid), "/T", "/F"]).catch(
            () => undefined
          );
        }
      }
    }
  }
} finally {
  server.closeAllConnections();
  server.close();
  await fsp.writeFile(
    path.join(root, "results.json"),
    JSON.stringify(trace, null, 2)
  );
  console.log(`Verification evidence: ${root}`);
}
