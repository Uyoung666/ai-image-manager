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
await fsp.writeFile(
  fixture,
  `const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
app.setPath("userData", ${JSON.stringify(path.join(directory, "profile"))});
app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true },
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    console.error(JSON.stringify(details));
    app.exit(1);
  });
  await window.loadURL("data:text/html,<p>standard user renderer</p>");
  const text = await window.webContents.executeJavaScript("document.body.innerText");
  if (text !== "standard user renderer") throw new Error("Renderer did not execute");
  fs.writeFileSync(${JSON.stringify(marker)}, "passed");
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
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
      AIM_STANDARD_ARGUMENTS: `"${fixture}"`,
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
} finally {
  clearTimeout(timer);
}
