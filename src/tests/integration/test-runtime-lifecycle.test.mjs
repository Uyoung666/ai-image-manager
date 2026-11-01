import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { isProcessAlive, TestRuntime } from "../helpers/test-runtime.ts";

test("closes successful, failing, unclosed and quit-blocked apps before runtime cleanup", {
  timeout: 90_000,
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
    const fixtureWorker = path.join(harness.root, "fixture-worker.cjs");
    fs.writeFileSync(
      fixtureWorker,
      "process.send('ready');setInterval(()=>{},1000);"
    );
    fs.writeFileSync(
      fixtureApp,
      `const {app,BrowserWindow}=require('electron');const {fork}=require('node:child_process');const fs=require('node:fs');const path=require('node:path');const root=process.argv.find(arg=>arg.startsWith('--runtime-root=')).slice('--runtime-root='.length);for(const [key,part] of Object.entries({appData:'appdata',cache:'cache',userData:'profile',sessionData:'profile',temp:'scratch',logs:'logs',crashDumps:'crashes'})){const dir=path.join(root,part);fs.mkdirSync(dir,{recursive:true});app.setPath(key,dir);}app.whenReady().then(()=>{if(process.argv.includes('--quit-before-window'))return app.exit(0);const options={execArgv:['-r',path.join(root,JSON.parse(fs.readFileSync(path.join(root,'.aim-test-runtime.json'),'utf8')).pendingRegistration+'.cjs')],env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}};const workerFile=${JSON.stringify(fixtureWorker)};const workers=[fork(workerFile,[],options),fork(workerFile,options),fork(workerFile,undefined,options)];Promise.all(workers.map(worker=>new Promise(resolve=>{worker.once('message',()=>worker.kill());worker.once('exit',resolve);}))).then(()=>{const window=new BrowserWindow({show:false});window.loadURL('data:text/html,Runtime probe');});});if(process.argv.includes('--block-quit'))app.on('before-quit',event=>event.preventDefault());app.on('window-all-closed',()=>app.quit());`
    );
    const spec = `import fs from 'node:fs';import path from 'node:path';import {expect} from '@playwright/test';import {test,createTestRuntime,launchTestApp,closeTestApp} from ${JSON.stringify(helper)};
for(const mode of ['success','assertion','setup','early','unclosed','blocked']){test.describe(mode,()=>{let root;test.beforeAll(()=>{root=createTestRuntime('lifecycle-'+mode);fs.writeFileSync(path.join(root,'electron.log'),'diagnostic-'+mode);fs.writeFileSync(path.join(root,'model.onnx'),'generated model');fs.writeFileSync(${JSON.stringify(harness.root)}+'/'+mode+'.txt',root);if(mode==='setup')throw new Error('controlled setup failure');});test('lifecycle',async()=>{if(mode==='early'){await expect(launchTestApp(root,{executablePath:${JSON.stringify(executablePath)},args:[${JSON.stringify(fixtureApp)},'--runtime-root='+root,'--quit-before-window']})).rejects.toThrow();return;}if(mode==='unclosed'||mode==='blocked'){const app=await launchTestApp(root,{executablePath:${JSON.stringify(executablePath)},args:[${JSON.stringify(fixtureApp)},'--runtime-root='+root,...(mode==='blocked'?['--block-quit']:[])]});fs.writeFileSync(${JSON.stringify(harness.root)}+'/'+mode+'.pid',String(await app.evaluate(()=>process.pid)));if(mode==='blocked')await expect(closeTestApp(app)).rejects.toThrow('Electron did not exit within 15 seconds');return;}for(let launch=0;launch<2;launch++){const app=await launchTestApp(root,{executablePath:${JSON.stringify(executablePath)},args:[${JSON.stringify(fixtureApp)},'--runtime-root='+root,'--user-data-dir='+path.join(root,'profile')]});await app.close();expect(JSON.parse(fs.readFileSync(path.join(root,'.aim-test-runtime.json'),'utf8')).childPids).toEqual([]);const records=fs.readdirSync(root).filter(name=>name.startsWith('process-launch-')&&name.endsWith('.json')).map(name=>JSON.parse(fs.readFileSync(path.join(root,name),'utf8')));expect(records).toHaveLength((launch+1)*4);expect(records.every(record=>record.exited)).toBe(true);}if(mode==='assertion')expect('actual','controlled assertion failure').toBe('expected');});});}`;
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
      { encoding: "utf8", timeout: 75_000 }
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1, result.stderr);
    assert.ok(result.stdout.includes("controlled setup failure"));
    assert.ok(result.stdout.includes("controlled assertion failure"));
    for (const mode of [
      "success",
      "assertion",
      "setup",
      "early",
      "unclosed",
      "blocked",
    ]) {
      const root = fs.readFileSync(
        path.join(harness.root, `${mode}.txt`),
        "utf8"
      );
      assert.equal(fs.existsSync(root), false, `${mode}: ${root}`);
    }
    for (const mode of ["unclosed", "blocked"]) {
      const pid = Number(
        fs.readFileSync(path.join(harness.root, `${mode}.pid`), "utf8")
      );
      assert.equal(
        isProcessAlive(pid),
        false,
        `${mode}: Electron PID ${pid} survived teardown`
      );
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
