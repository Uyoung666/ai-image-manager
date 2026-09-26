import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import {
  _electron,
  type ElectronApplication,
  expect,
  test,
} from "@playwright/test";
import sharp from "sharp";

const electronPath = createRequire(import.meta.url)("electron") as string;
const PROTECTED_EXTENSION = /\.(csv|xlsx)$/i;
const NUMERIC_TAG_PATTERN = /55555/;
const TAG = "FSevenMarker";

declare global {
  interface Window {
    f07Gate: {
      armed: boolean;
      held: number;
      release: () => void;
      requests: number;
      browseRequests: number;
    };
  }
}

test("tag removal refreshes active results and rejects a delayed old response across restart", async () => {
  test.setTimeout(240_000);
  const base = path.resolve(".test-runtime");
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, "f07-"));
  const fixture = path.join(root, "fixture");
  const profile = path.join(root, "profile");
  fs.mkdirSync(fixture);
  let app: ElectronApplication | undefined;
  const requireApp = () => {
    assert(app);
    return app;
  };
  const save = (name: string, data: unknown) =>
    fs.writeFileSync(
      test.info().outputPath(name),
      JSON.stringify(data, null, 2)
    );
  try {
    for (let i = 0; i < 4; i++) {
      await sharp({
        create: {
          width: 96,
          height: 64,
          channels: 3,
          background: { r: i * 50, g: 60, b: 170 },
        },
      })
        .png()
        .toFile(path.join(fixture, `photo-${i}.png`));
    }
    const preload = path.join(root, "isolation.cjs");
    fs.writeFileSync(
      preload,
      `const {app}=require('electron');const fs=require('node:fs');const path=require('node:path');for(const [key,part] of Object.entries({appData:'appdata',cache:'cache',userData:'profile',sessionData:'profile',temp:'scratch',logs:'logs',crashDumps:'crashes'})){const p=path.join(__dirname,part);fs.mkdirSync(p,{recursive:true});app.setPath(key,p);}`
    );
    const env = Object.fromEntries(
      Object.entries({
        ...process.env,
        ELECTRON_RUN_AS_NODE: undefined,
        CI: "e2e",
        AI_IMAGE_MANAGER_E2E_USER_DATA_DIR: profile,
        AI_IMAGE_MANAGER_USER_DATA_DIR: profile,
        APPDATA: path.join(root, "appdata"),
        LOCALAPPDATA: path.join(root, "local"),
        TEMP: path.join(root, "scratch"),
        TMP: path.join(root, "scratch"),
      }).filter((entry): entry is [string, string] => entry[1] !== undefined)
    );
    const dbPath = path.join(profile, "data/ai-image-manager.db");
    const query = (sql: string, setup = false) =>
      JSON.parse(
        execFileSync(
          electronPath,
          [
            "-e",
            "const D=require('better-sqlite3');const d=new D(process.argv[1],{readonly:process.argv[3]!=='setup'});try{if(process.argv[3]==='setup'){d.exec(process.argv[2]);console.log('[]')}else{console.log(JSON.stringify(d.prepare(process.argv[2]).all()))}}finally{d.close()}",
            dbPath,
            sql,
            setup ? "setup" : "read",
          ],
          { env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8" }
        )
      );
    const launch = async () => {
      app = await _electron.launch({
        args: ["-r", preload, "--e2e", "--lang=zh-CN", path.resolve(".")],
        env,
      });
      app
        .process()
        .stderr?.on("data", (data) =>
          fs.appendFileSync(test.info().outputPath("stderr.log"), data)
        );
      const paths = await app.evaluate(({ app: instance }) =>
        ["userData", "sessionData", "appData", "temp", "logs"].map((key) =>
          instance.getPath(key as Parameters<typeof instance.getPath>[0])
        )
      );
      expect(
        paths.every((value) => path.resolve(value).startsWith(root + path.sep))
      ).toBe(true);
      save("isolation.json", paths);
      const page = await app.firstWindow();
      await page.addInitScript(() => {
        // Hold a real RPC response, without changing its payload or the DB.
        // Later mutations and searches continue normally on the same port.
        const requests = new Set<unknown>();
        const held: Array<() => void> = [];
        const gate = {
          armed: false,
          held: 0,
          requests: 0,
          browseRequests: 0,
          release: () => {
            for (const deliver of held.splice(0)) {
              deliver();
            }
            gate.held = 0;
          },
        };
        window.f07Gate = gate;
        const send = MessagePort.prototype.postMessage;
        MessagePort.prototype.postMessage = function (message, transfer) {
          const request =
            typeof message === "string" ? JSON.parse(message) : message;
          if (request?.p?.u?.includes("listPhotos")) {
            gate.browseRequests++;
          }
          if (request?.p?.u?.includes("searchCompound")) {
            requests.add(request.i);
            gate.requests++;
          }
          if (Array.isArray(transfer)) {
            send.call(this, message, { transfer });
          } else {
            send.call(this, message, transfer ?? {});
          }
        };
        const listen = MessagePort.prototype.addEventListener;
        MessagePort.prototype.addEventListener = function (
          type: string,
          listener: EventListenerOrEventListenerObject | null,
          options?: boolean | AddEventListenerOptions
        ) {
          if (!listener) {
            return;
          }
          if (type !== "message" || typeof listener !== "function") {
            return listen.call(this, type, listener, options);
          }
          return listen.call(
            this,
            type,
            (event) => {
              const raw = (event as MessageEvent).data;
              const data = typeof raw === "string" ? JSON.parse(raw) : raw;
              if (requests.has(data?.i) && gate.armed) {
                gate.armed = false;
                held.push(() => listener.call(this, event));
                gate.held = held.length;
                return;
              }
              listener.call(this, event);
            },
            options
          );
        };
      });
      await page.reload();
      await page
        .getByRole("button", { name: "添加文件夹", exact: true })
        .first()
        .waitFor();
      return page;
    };
    let page = await launch();
    await requireApp().evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [folder],
      });
    }, fixture);
    await page
      .getByRole("button", { name: "添加文件夹", exact: true })
      .first()
      .press("Enter");
    await expect
      .poll(
        () =>
          query("select count(*) n from photos where is_ai_processed=1")[0].n,
        { timeout: 150_000 }
      )
      .toBe(4);
    await requireApp().close();
    app = undefined;
    // Seed only this isolated fixture; removals below use the actual UI and handler.
    query(
      "INSERT INTO tags(id,name,created_at) VALUES(9001,'FSevenMarker',1); INSERT INTO photo_tags(photo_id,tag_id,is_confirmed,origin,user_confirmed) SELECT id,9001,1,'manual',1 FROM photos ORDER BY id LIMIT 3;",
      true
    );
    page = await launch();
    const input = page.locator("input.home-search-input");
    await input.fill(TAG);
    await input.press("Enter");
    const cards = page.locator("[data-photo-id]");
    await expect(cards).toHaveCount(3);
    const before = await cards.evaluateAll((nodes) =>
      nodes.map((node) => Number(node.getAttribute("data-photo-id")))
    );
    save("before.json", {
      visible: before,
      relations: query("select photo_id from photo_tags where tag_id=9001"),
    });
    await cards.first().click();
    await page.evaluate(() => {
      window.f07Gate.armed = true;
    });
    await input.press("Enter");
    await expect.poll(() => page.evaluate(() => window.f07Gate.held)).toBe(1);
    const remove = page
      .getByRole("button", { name: "点击移除", exact: true })
      .filter({ hasText: TAG });
    await remove.click();
    await expect(cards).toHaveCount(2);
    await cards.first().click();
    await remove.click();
    await expect(cards).toHaveCount(1);
    const after = query("select photo_id from photo_tags where tag_id=9001");
    const visible = await cards.evaluateAll((nodes) =>
      nodes.map((node) => Number(node.getAttribute("data-photo-id")))
    );
    expect(visible).toEqual(
      after.map((row: { photo_id: number }) => row.photo_id)
    );
    await page.evaluate(() => window.f07Gate.release());
    // Two animation frames let the released promise and React updates settle.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
    );
    await expect(cards).toHaveCount(1);
    expect(
      await cards.evaluateAll((nodes) =>
        nodes.map((node) => Number(node.getAttribute("data-photo-id")))
      )
    ).toEqual(visible);
    save("after.json", { visible, relations: after });
    await page.screenshot({ path: test.info().outputPath("after.png") });
    await requireApp().close();
    app = undefined;
    page = await launch();
    await page.locator("input.home-search-input").fill(TAG);
    await page.locator("input.home-search-input").press("Enter");
    await expect(page.locator("[data-photo-id]")).toHaveCount(1);
    expect(query("select photo_id from photo_tags where tag_id=9001")).toEqual(
      after
    );
    expect(query("pragma foreign_key_check")).toEqual([]);
    save("restart.json", {
      relations: after,
      totalPhotos: query("select count(*) n from photos")[0].n,
    });
    await page.getByRole("button", { name: "清除搜索", exact: true }).click();
    await expect(page.locator("[data-photo-id]")).toHaveCount(4);
    await page.locator(`[data-photo-id="${after[0].photo_id}"]`).click();
    const requestsBefore = await page.evaluate(() => ({
      search: window.f07Gate.requests,
      browse: window.f07Gate.browseRequests,
    }));
    await page
      .getByRole("button", { name: "点击移除", exact: true })
      .filter({ hasText: TAG })
      .click();
    await expect
      .poll(
        () => query("select count(*) n from photo_tags where tag_id=9001")[0].n
      )
      .toBe(0);
    await expect(
      page
        .getByRole("button", { name: "点击移除", exact: true })
        .filter({ hasText: TAG })
    ).toHaveCount(0);
    await expect(page.locator("[data-photo-id]")).toHaveCount(4);
    const requestsAfter = await page.evaluate(() => ({
      search: window.f07Gate.requests,
      browse: window.f07Gate.browseRequests,
    }));
    expect(requestsAfter).toEqual(requestsBefore);
    save("ordinary-browse.json", { requestsBefore, requestsAfter, visible: 4 });

    // Creating a tag in details and deleting it in the tree must refresh the
    // already mounted search bar, including numeric-prefix suggestions.
    await page.getByRole("button", { name: "+ 添加", exact: true }).click();
    await page.getByPlaceholder("输入新标签名称...").fill("55555");
    await page.getByPlaceholder("输入新标签名称...").press("Enter");
    const searchInput = page.locator("input.home-search-input");
    await searchInput.fill("5");
    await expect(
      page.getByRole("option", { name: NUMERIC_TAG_PATTERN })
    ).toBeVisible();
    const numericTag = query("select id from tags where name='55555'")[0];
    await searchInput.press("Escape");
    await page.getByRole("button", { name: "标签", exact: true }).click();
    await page
      .locator(`[data-tag-id="${numericTag.id}"]`)
      .click({ button: "right" });
    await page.getByRole("button", { name: "删除标签", exact: true }).click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "删除", exact: true })
      .click();
    await expect
      .poll(() => query("select count(*) n from tags where name='55555'")[0].n)
      .toBe(0);
    await searchInput.fill("");
    await searchInput.fill("5");
    await searchInput.focus();
    await expect(
      page.getByRole("option", { name: NUMERIC_TAG_PATTERN })
    ).toHaveCount(0);
    save("tag-suggestions.json", {
      created: "55555",
      prefix: "5",
      deleted: true,
      remaining: query("select id from tags where name='55555'"),
    });
  } finally {
    await app?.close();
    assert.equal(path.dirname(root), base);
    assert.equal(
      fs
        .readdirSync(root, { recursive: true, withFileTypes: true })
        .find(
          (entry) =>
            PROTECTED_EXTENSION.test(entry.name) ||
            (entry.isDirectory() && entry.name.toLowerCase() === "temp") ||
            entry.isSymbolicLink()
        ),
      undefined
    );
    fs.rmSync(root, { recursive: true, force: true });
    save("cleanup.json", { root, exists: fs.existsSync(root) });
  }
});
