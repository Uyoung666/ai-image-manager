import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { TestRuntime } from "../helpers/test-runtime.ts";

test("cleans success, assertion failure and setup failure runtimes while preserving diagnostics", {
  timeout: 60_000,
}, () => {
  const harness = new TestRuntime(
    "runtime-lifecycle-probe",
    path.resolve(".cache")
  );
  const errors = [];
  try {
    const outputDir = path.join(harness.root, "results");
    const helper = path
      .resolve("src/tests/e2e/helpers/test-runtime.ts")
      .replaceAll("\\", "/");
    const executablePath = createRequire(import.meta.url)("electron");
    const fixtureApp = path.join(harness.root, "fixture-app.cjs");
    fs.writeFileSync(
      fixtureApp,
      "const {app,BrowserWindow}=require('electron');const fs=require('node:fs');const path=require('node:path');const root=process.argv.find(arg=>arg.startsWith('--runtime-root=')).slice('--runtime-root='.length);for(const [key,part] of Object.entries({appData:'appdata',cache:'cache',userData:'profile',sessionData:'profile',temp:'scratch',logs:'logs',crashDumps:'crashes'})){const dir=path.join(root,part);fs.mkdirSync(dir,{recursive:true});app.setPath(key,dir);}app.whenReady().then(()=>{const window=new BrowserWindow({show:false});window.loadURL('data:text/html,Runtime probe');});app.on('window-all-closed',()=>app.quit());"
    );
    const spec = `import fs from 'node:fs';import path from 'node:path';import {expect} from '@playwright/test';import {test,createTestRuntime,launchTestApp} from ${JSON.stringify(helper)};
for(const mode of ['success','assertion','setup']){test.describe(mode,()=>{let root;test.beforeAll(()=>{root=createTestRuntime('lifecycle-'+mode);fs.writeFileSync(path.join(root,'electron.log'),'diagnostic-'+mode);fs.writeFileSync(path.join(root,'model.onnx'),'generated model');fs.writeFileSync(${JSON.stringify(harness.root)}+'/'+mode+'.txt',root);if(mode==='setup')throw new Error('controlled setup failure');});test('lifecycle',async()=>{const app=await launchTestApp(root,{executablePath:${JSON.stringify(executablePath)},args:[${JSON.stringify(fixtureApp)},'--runtime-root='+root,'--user-data-dir='+path.join(root,'profile')]});await app.close();if(mode==='assertion')expect('actual','controlled assertion failure').toBe('expected');});});}`;
    fs.writeFileSync(path.join(harness.root, "lifecycle.spec.ts"), spec);
    const config = path.join(harness.root, "playwright.config.mjs");
    fs.writeFileSync(
      config,
      `export default ${JSON.stringify({ testDir: harness.root, outputDir, workers: 1, retries: 0, reporter: "json" })};`
    );
    const result = spawnSync(
      process.execPath,
      [
        path.resolve("node_modules/@playwright/test/cli.js"),
        "test",
        "--config",
        config,
      ],
      { encoding: "utf8", timeout: 45_000 }
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1, result.stderr);
    assert.ok(result.stdout.includes("controlled setup failure"));
    assert.ok(result.stdout.includes("controlled assertion failure"));
    for (const mode of ["success", "assertion", "setup"]) {
      const root = fs.readFileSync(
        path.join(harness.root, `${mode}.txt`),
        "utf8"
      );
      assert.equal(fs.existsSync(root), false, `${mode}: ${root}`);
    }
    const files = fs.readdirSync(outputDir, { recursive: true }).map(String);
    assert.ok(
      files.filter((file) => path.basename(file) === "electron.log").length >= 3
    );
    assert.equal(
      files.some((file) => file.endsWith(".onnx")),
      false
    );
  } catch (error) {
    errors.push(error);
  } finally {
    try {
      assert.equal(harness.cleanup().status, "deleted");
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) {
    throw new AggregateError(
      errors,
      "Playwright runtime lifecycle probe failed"
    );
  }
});
