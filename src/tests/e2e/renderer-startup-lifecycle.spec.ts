import fs from "node:fs";
import path from "node:path";
import { _electron, expect, test } from "@playwright/test";

const APP_PATH = path.resolve(".");
const LOAD_FAILURE = "Controlled renderer load failure";

function createFixture(mode: "quit" | "fail") {
  const base = path.resolve(".test-runtime");
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, `renderer-load-${mode}-`));
  const profile = path.join(root, "profile");
  const hook = path.join(root, "isolation.cjs");
  fs.writeFileSync(
    hook,
    `const {app,BrowserWindow,dialog}=require('electron');
const fs=require('node:fs');const path=require('node:path');
for(const [key,part] of Object.entries({appData:'appdata',cache:'cache',userData:'profile',sessionData:'profile',temp:'scratch',logs:'logs',crashDumps:'crashes'})){const p=path.join(__dirname,part);fs.mkdirSync(p,{recursive:true});app.setPath(key,p);}
dialog.showMessageBox=async()=>({response:1,checkboxChecked:false});
const loadFile=BrowserWindow.prototype.loadFile;
BrowserWindow.prototype.loadFile=function(...args){
  ${
    mode === "fail"
      ? `return Promise.reject(new Error(${JSON.stringify(LOAD_FAILURE)}));`
      : `this.webContents.session.webRequest.onBeforeRequest({urls:['file://*/*']},()=>{});
  const pending=loadFile.apply(this,args);app.quit();return pending;`
  }
};`
  );
  return { hook, profile, root };
}

function readIncidents(profile: string) {
  const file = path.join(profile, "diagnostics", "incidents.jsonl");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

test.setTimeout(60_000);

test("a real renderer load failure remains actionable", async () => {
  const fixture = createFixture("fail");
  const app = await _electron.launch({
    args: ["-r", fixture.hook, "--e2e", APP_PATH],
    env: {
      ...process.env,
      AI_IMAGE_MANAGER_E2E_USER_DATA_DIR: fixture.profile,
      CI: "e2e",
    },
  });
  try {
    await expect
      .poll(() => readIncidents(fixture.profile))
      .toContain(LOAD_FAILURE);
    expect(readIncidents(fixture.profile)).toContain('"startup-failure"');
  } finally {
    await app.close();
  }
});

test("quitting during the initial renderer load does not create a startup fault", async () => {
  const fixture = createFixture("quit");
  // The early quit can beat Playwright's launch handshake; the process and its
  // shutdown logs are the observable result rather than a loaded page.
  const app = await _electron
    .launch({
      args: ["-r", fixture.hook, "--e2e", APP_PATH],
      env: {
        ...process.env,
        AI_IMAGE_MANAGER_E2E_USER_DATA_DIR: fixture.profile,
        CI: "e2e",
      },
      timeout: 20_000,
    })
    .catch(() => undefined);
  try {
    const cleanupLog = path.join(fixture.profile, "logs", "migrate.log");
    await expect
      .poll(
        () =>
          fs.existsSync(cleanupLog) ? fs.readFileSync(cleanupLog, "utf8") : "",
        { timeout: 30_000 }
      )
      .toContain("quit-cleanup: DONE");
    expect(readIncidents(fixture.profile)).toBe("");
  } finally {
    await app?.close().catch(() => undefined);
  }
});
