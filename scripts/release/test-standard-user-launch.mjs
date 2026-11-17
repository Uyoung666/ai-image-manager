import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import electron from "electron";
import { cleanupProductArtifacts } from "./update-product-gate.mjs";

const root = path.resolve(".test-runtime");
await fsp.mkdir(root, { recursive: true });
const directory = await fsp.mkdtemp(
  path.join(root, "product-update-standard-user-")
);
const fixture = path.join(directory, "probe.cjs");
const marker = path.join(directory, "ready.txt");
const diagnostic = path.join(directory, "probe.log");
const chromiumLog = path.join(directory, "chromium.log");
await fsp.writeFile(
  fixture,
  `const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const log = (message) => fs.appendFileSync(
  ${JSON.stringify(diagnostic)}, new Date().toISOString() + " " + message + "\\n"
);
log("main entry");
process.on("uncaughtException", error => { log(error.stack); app.exit(1); });
process.on("unhandledRejection", error => { log(String(error)); app.exit(1); });
app.setPath("userData", ${JSON.stringify(path.join(directory, "profile"))});
app.whenReady().then(async () => {
  log("app ready");
  require("node:child_process").execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
      ${JSON.stringify(path.join(import.meta.dirname, "start-standard-user.ps1"))}],
    {
      env: { ...process.env, AIM_STANDARD_VERIFY_PID: String(process.pid) },
      windowsHide: true,
    }
  );
  log("own token access passed");
  const window = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true },
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    log("renderer gone " + JSON.stringify(details));
    console.error(JSON.stringify(details));
    app.exit(1);
  });
  log("loading renderer");
  await window.loadURL("data:text/html,<p>standard user renderer</p>");
  log("renderer loaded");
  const text = await window.webContents.executeJavaScript("document.body.innerText");
  if (text !== "standard user renderer") throw new Error("Renderer did not execute");
  fs.writeFileSync(${JSON.stringify(marker)}, "passed");
  log("renderer executed");
  app.quit();
}).catch(error => { log(error.stack); console.error(error); app.exit(1); });
`
);
const child = spawn(
  "powershell.exe",
  [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    path.join(import.meta.dirname, "start-standard-user.ps1"),
  ],
  {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: undefined,
      AIM_STANDARD_VERIFY_PID: undefined,
      AIM_STANDARD_MSI_ROOT: undefined,
      AIM_STANDARD_EXECUTABLE: electron,
      AIM_STANDARD_ARGUMENTS: `"${fixture}" --enable-logging=file --log-file="${chromiumLog}"`,
    },
    windowsHide: true,
    stdio: "inherit",
  }
);
let timer;
try {
  await new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      const cleanup = spawn(
        "taskkill.exe",
        ["/PID", String(child.pid), "/T", "/F"],
        {
          windowsHide: true,
          stdio: "ignore",
        }
      );
      cleanup.on("error", () => child.kill());
      reject(
        new Error(`Standard-user renderer timed out; diagnostics: ${directory}`)
      );
    }, 60_000);
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`Standard-user renderer exited: ${code}`))
    );
  });
  if ((await fsp.readFile(marker, "utf8")) !== "passed") {
    throw new Error("Standard-user renderer did not complete");
  }
  const retained = await cleanupProductArtifacts(directory);
  if (retained.length) {
    console.log(`Protected probe files retained: ${JSON.stringify(retained)}`);
  }
  console.log("Standard-user Electron sandbox renderer passed");
} catch (error) {
  for (const file of [diagnostic, chromiumLog]) {
    console.error(
      `${file}\n${await fsp.readFile(file, "utf8").catch(() => "No log written")}`
    );
  }
  throw error;
} finally {
  clearTimeout(timer);
}
