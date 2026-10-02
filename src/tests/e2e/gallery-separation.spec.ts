import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import {
  _electron,
  type ElectronApplication,
  expect,
  type Page,
  test,
} from "@playwright/test";
import sharp from "sharp";

const electronPath = createRequire(import.meta.url)("electron") as string;
const SEQUENCES = /^Sequences/;
const GROUP_IDS = [1, 2, 3, 110, 111, 112, 168, 169, 170];
const SIZES = [
  { width: 720, height: 480 },
  { width: 900, height: 600 },
  { width: 1280, height: 800 },
];
declare global {
  interface Window {
    gallerySequenceGate: {
      armed: boolean;
      operation: "listSequences" | "listPhotos";
      held: number;
      skip: number;
      sequenceRequests: number;
      searches: number;
      release: (fail?: boolean) => void;
    };
  }
}
let app: ElectronApplication;
let page: Page;
let root: string;
let profile: string;
let env: Record<string, string>;

function query(sql: string, write = false) {
  return JSON.parse(
    execFileSync(
      electronPath,
      [
        "-e",
        "const D=require('better-sqlite3');const d=new D(process.argv[1]);const sql=require('node:fs').readFileSync(0,'utf8');try{if(process.argv[2]==='write'){d.exec(sql);console.log('[]')}else{console.log(JSON.stringify(d.prepare(sql).all()))}}finally{d.close()}",
        path.join(profile, "data", "ai-image-manager.db"),
        write ? "write" : "read",
      ],
      {
        env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
        encoding: "utf8",
        input: sql,
      }
    )
  );
}

async function launch() {
  app = await _electron.launch({
    args: [
      "-r",
      path.join(root, "isolation.cjs"),
      "--e2e",
      process.env.AIM_GALLERY_E2E_APP_PATH ?? path.resolve("."),
    ],
    env,
  });
  app
    .process()
    .stderr?.on("data", (data) =>
      fs.appendFileSync(path.join(root, "electron.log"), data)
    );
  page = await app.firstWindow();
  await page.addInitScript(() => {
    localStorage.setItem("lang", "en");
    localStorage.setItem("ui.reduceMotion", "false");
    const held: Array<(fail: boolean) => void> = [];
    let target: unknown = null;
    const searchRequests = new Set<unknown>();
    const gate = {
      armed: false,
      operation: "listSequences" as "listSequences" | "listPhotos",
      held: 0,
      skip: 0,
      sequenceRequests: 0,
      searches: 0,
      release: (fail = false) => {
        for (const deliver of held.splice(0)) {
          deliver(fail);
        }
        gate.held = 0;
      },
    };
    window.gallerySequenceGate = gate;
    const send = MessagePort.prototype.postMessage;
    MessagePort.prototype.postMessage = function (message, transfer) {
      const request =
        typeof message === "string" ? JSON.parse(message) : message;
      if (request?.p?.u?.includes("searchCompound")) {
        searchRequests.add(request.i);
      }
      if (request?.p?.u?.includes("listSequences")) {
        gate.sequenceRequests++;
      }
      if (request?.p?.u?.includes(gate.operation) && gate.armed) {
        if (gate.skip > 0) {
          gate.skip--;
        } else {
          target = request.i;
          gate.armed = false;
        }
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
          const response = typeof raw === "string" ? JSON.parse(raw) : raw;
          if (searchRequests.has(response?.i)) {
            gate.searches++;
          }
          if (target !== null && response?.i === target) {
            target = null;
            held.push((fail) => {
              const failed = {
                ...response,
                p: {
                  ...response.p,
                  s: 500,
                  b: {
                    json: {
                      code: "INTERNAL_SERVER_ERROR",
                      message: "fixture failure",
                      status: 500,
                      defined: false,
                    },
                  },
                },
              };
              listener.call(
                this,
                fail
                  ? new MessageEvent("message", {
                      data:
                        typeof raw === "string"
                          ? JSON.stringify(failed)
                          : failed,
                    })
                  : event
              );
            });
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
  await page.waitForFunction(() => Boolean(window.__e2eNavigate));
  await navigate("/");
}

async function navigate(route: string) {
  await page.evaluate((next) => window.__e2eNavigate?.(next), route);
  await page.locator("main").first().waitFor();
}

test.describe.configure({ mode: "serial" });
test.setTimeout(120_000);
test.beforeAll(async () => {
  const base = path.resolve(".test-runtime");
  fs.mkdirSync(base, { recursive: true });
  root = fs.mkdtempSync(path.join(base, "gallery-separation-"));
  profile = path.join(root, "profile");
  fs.writeFileSync(
    path.join(root, "isolation.cjs"),
    "const {app}=require('electron');const fs=require('node:fs');const path=require('node:path');for(const [key,part] of Object.entries({appData:'appdata',cache:'cache',userData:'profile',sessionData:'profile',temp:'scratch',logs:'logs',crashDumps:'crashes'})){const p=path.join(__dirname,part);fs.mkdirSync(p,{recursive:true});app.setPath(key,p);}"
  );
  env = Object.fromEntries(
    Object.entries({
      ...process.env,
      ELECTRON_RUN_AS_NODE: undefined,
      CI: "e2e",
      AI_IMAGE_MANAGER_E2E_USER_DATA_DIR: profile,
      AI_IMAGE_MANAGER_USER_DATA_DIR: profile,
    }).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
  await launch();
  await app.close();
  const fixture = path.join(root, "fixture");
  fs.mkdirSync(fixture);
  const image = await sharp({
    create: {
      width: 160,
      height: 100,
      channels: 3,
      background: { r: 75, g: 135, b: 185 },
    },
  })
    .png()
    .toBuffer();
  const sqlEscape = (value: string) => value.replaceAll("'", "''");
  const statements = [
    `INSERT INTO folders(id,path,display_name,photo_count,created_at) VALUES(1,'${sqlEscape(fixture)}','GalleryFixture',270,1)`,
  ];
  for (let id = 1; id <= 270; id++) {
    const photoPath = path.join(
      fixture,
      `GalleryFixture-${String(id).padStart(3, "0")}.png`
    );
    fs.writeFileSync(photoPath, image);
    statements.push(
      `INSERT INTO photos(id,path,filename,folder_id,file_size,file_date,width,height,format,thumbnail_path,is_favorite,is_indexed,is_ai_processed,is_face_processed,created_at) VALUES(${id},'${sqlEscape(photoPath)}','GalleryFixture-${String(id).padStart(3, "0")}.png',1,1024,${id},160,100,'png','${sqlEscape(photoPath)}',1,1,1,1,1)`
    );
  }
  for (const [index, members] of [
    [1, 2, 3],
    [110, 111, 112],
    [168, 169, 170],
  ].entries()) {
    statements.push(
      `INSERT INTO photo_sequences(id,folder_id,type,source,representative_photo_id,started_at,ended_at,frame_count,user_locked,created_at,updated_at) VALUES(${index + 1},1,'burst','manual',${members[0]},${members[0]},${members[2]},3,1,1,1)`
    );
    members.forEach((id, position) => {
      statements.push(
        `INSERT INTO photo_sequence_members(sequence_id,photo_id,position) VALUES(${index + 1},${id},${position})`
      );
    });
  }
  statements.push(
    "INSERT INTO albums(id,name,created_at) VALUES(9001,'GalleryFixture',1)"
  );
  statements.push(
    'INSERT INTO albums(id,name,is_smart,smart_rules,created_at) VALUES(9002,\'GallerySmartFixture\',1,\'{"rules":[{"type":"fileFormat","value":"png"}]}\',1)'
  );
  statements.push(
    "INSERT INTO album_photos(album_id,photo_id) SELECT 9001,id FROM photos"
  );
  statements.push(
    "INSERT INTO exif_data(photo_id,camera_model) SELECT id,'GalleryFixture' FROM photos"
  );
  statements.push(
    "INSERT INTO face_identities(id,name,representative_photo_id,face_count,is_confirmed,created_at) VALUES(9001,'GalleryFixture',4,270,1,1)"
  );
  statements.push(
    "INSERT INTO face_vectors(id,photo_id,bbox_x,bbox_y,bbox_width,bbox_height,confidence,created_at) SELECT id,id,0.1,0.1,0.5,0.5,1,1 FROM photos"
  );
  statements.push(
    "INSERT INTO face_identity_members(identity_id,face_vector_id) SELECT 9001,id FROM face_vectors"
  );
  query(statements.join(";"), true);
  await launch();
});
test.afterAll(async () => {
  await app?.close();
});

for (const albumId of [9001, 9002]) {
  test(`album ${albumId} preserves an expanded member favorite after returning from Favorites`, async () => {
    await navigate("/people/9001");
    await page.locator(".page-toolbar").waitFor();
    query("UPDATE photos SET is_favorite=0 WHERE id=2", true);
    await navigate(`/albums/${albumId}`);
    await page.getByRole("button", { name: SEQUENCES }).click();
    const group = page.locator('[data-sequence-id="1"]');
    await expect(group).toBeVisible();
    await group
      .getByRole("button", { name: "Expand sequence photos", exact: true })
      .click();
    const member = page.locator('[data-photo-id="2"][role="option"]');
    await expect(member).toBeVisible();
    await member.getByRole("button", { name: "Favorite", exact: true }).click();
    await expect
      .poll(
        () =>
          query("SELECT is_favorite favorite FROM photos WHERE id=2")[0]
            .favorite
      )
      .toBe(1);
    await expect(
      member.getByRole("button", { name: "Unfavorite", exact: true })
    ).toHaveAttribute("aria-pressed", "true");
    await navigate("/");
    await expect(page.locator(".home-gallery-toolbar-layer")).toBeVisible();
    await page
      .getByRole("button", { name: "Favorite", exact: true })
      .first()
      .click();
    await expect(page.locator(".home-gallery-toolbar-layer")).toBeVisible();
    await page.getByRole("button", { name: SEQUENCES }).click();
    await page
      .locator('[data-sequence-id="1"]')
      .getByRole("button", { name: "Expand sequence photos", exact: true })
      .click();
    await expect(
      member.getByRole("button", { name: "Unfavorite", exact: true })
    ).toHaveAttribute("aria-pressed", "true");
    await navigate(`/albums/${albumId}`);
    await page.getByRole("button", { name: SEQUENCES }).click();
    await page
      .locator('[data-sequence-id="1"]')
      .getByRole("button", { name: "Expand sequence photos", exact: true })
      .click();
    await expect(
      member.getByRole("button", { name: "Unfavorite", exact: true })
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      query("SELECT is_favorite favorite FROM photos WHERE id=2")[0].favorite
    ).toBe(1);
  });
}

for (const size of SIZES) {
  test(`${size.width}x${size.height} preserves toolbar, separation and detail layout`, async () => {
    await app.evaluate(
      ({ BrowserWindow }, requested) =>
        BrowserWindow.getAllWindows()[0].setSize(
          requested.width,
          requested.height
        ),
      size
    );
    for (const route of ["/", "/albums/9001", "/people/9001"]) {
      await navigate(route);
      const toolbar = page.locator(
        route === "/" ? ".home-gallery-toolbar-layer" : ".page-toolbar"
      );
      const photosButton = page.getByRole("button", {
        name: "Photos",
        exact: true,
      });
      await photosButton.click();
      await expect(page.locator("[data-photo-id]").first()).toBeVisible();
      for (const id of GROUP_IDS) {
        await expect(page.locator(`[data-photo-id="${id}"]`)).toHaveCount(0);
      }
      await page.getByRole("button", { name: SEQUENCES }).click();
      await expect(page.locator("[data-sequence-id]")).toHaveCount(3);
      await photosButton.click();
      // Save multiple frames across the entire mode animation, not just the settled state.
      for (let frame = 0; frame < 4; frame++) {
        await expect(toolbar).toBeVisible();
        const covered = await toolbar.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return !element.contains(
            document.elementFromPoint(rect.left + 8, rect.top + 8)
          );
        });
        expect(covered).toBe(false);
        await page.screenshot({
          path: test
            .info()
            .outputPath(`${route.replaceAll("/", "_")}-${frame}.png`),
        });
      }
      await expect(page.locator("[data-sequence-id]")).toHaveCount(0);
      await page.locator("[data-photo-id]").first().click();
      await expect(
        page.locator('.photo-detail-panel-shell [data-surface="inspector"]')
      ).toBeVisible();
      const gallery = page.locator("[data-masonry-scroll]");
      await expect(gallery).toBeVisible();
      await page.keyboard.press("Escape");
      for (let frame = 0; frame < 3; frame++) {
        await expect(gallery).toBeVisible();
        await expect(gallery.locator("[data-photo-id]").first()).toBeVisible();
        if (route === "/") {
          await expect(page.locator(".home-gallery-restore-content")).toHaveCSS(
            "opacity",
            "1"
          );
        }
        await page.screenshot({
          path: test
            .info()
            .outputPath(
              `${route.replaceAll("/", "_")}-detail-close-${frame}.png`
            ),
        });
      }
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              document
                .querySelector(".photo-detail-panel-shell")
                ?.getBoundingClientRect().width ?? 0
          )
        )
        .toBe(0);
      const overflow = await page.evaluate(() =>
        [
          document.documentElement,
          document.body,
          ...document.querySelectorAll("main"),
        ].some((element) => element.scrollWidth > element.clientWidth + 2)
      );
      expect(overflow).toBe(false);
    }
  });
}

test("sequence all-select resolves unloaded members and toggles their actual favorite state", async () => {
  await navigate("/");
  await page.getByRole("button", { name: SEQUENCES }).click();
  await expect(page.locator("[data-sequence-id]")).toHaveCount(3);
  await page
    .locator("main")
    .first()
    .click({ position: { x: 6, y: 200 } });
  await page.keyboard.press("Control+a");
  await expect(page.locator(".selection-action-layer")).toBeVisible();
  await page.keyboard.press("f");
  await expect
    .poll(
      () =>
        query(
          "SELECT count(*) n FROM photos WHERE id IN (SELECT photo_id FROM photo_sequence_members) AND is_favorite=1"
        )[0].n
    )
    .toBe(0);
  expect(
    query(
      "SELECT count(*) n FROM photos WHERE id NOT IN (SELECT photo_id FROM photo_sequence_members) AND is_favorite=1"
    )[0].n
  ).toBe(261);
  await page.getByRole("button", { name: "Undo", exact: true }).last().click();
  await expect
    .poll(() => query("SELECT count(*) n FROM photos WHERE is_favorite=1")[0].n)
    .toBe(270);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Photos", exact: true }).click();
});

test("rapid mode changes restore photo scroll after the query and layout settle", async () => {
  await navigate("/?reset=true");
  await page.getByRole("button", { name: "Photos", exact: true }).click();
  const scroll = page.locator("[data-masonry-scroll]");
  await expect(scroll).toBeVisible();
  await scroll.evaluate((element) => {
    element.scrollTop = 700;
  });
  await expect
    .poll(() => scroll.evaluate((element) => element.scrollTop))
    .toBe(700);
  for (let cycle = 0; cycle < 3; cycle++) {
    await page.getByRole("button", { name: SEQUENCES }).click();
    await page.getByRole("button", { name: "Photos", exact: true }).click();
  }
  await expect(page.locator("[data-sequence-id]")).toHaveCount(0);
  await expect
    .poll(() => scroll.evaluate((element) => element.scrollTop))
    .toBe(700);
});

test("delayed appended ownership stays hidden, survives failure and can retry", async () => {
  await navigate("/albums/9001");
  await page.locator(".page-toolbar").waitFor();
  await navigate("/");
  await page.getByRole("button", { name: "Photos", exact: true }).click();
  const sequenceRequests = await page.evaluate(
    () => window.gallerySequenceGate.sequenceRequests
  );
  await navigate("/?cameraModel=GalleryFixture");
  await expect
    .poll(() => page.evaluate(() => window.gallerySequenceGate.searches))
    .toBeGreaterThan(0);
  await expect
    .poll(() =>
      page.evaluate(() => window.gallerySequenceGate.sequenceRequests)
    )
    .toBeGreaterThan(sequenceRequests);
  await expect(page.locator('[data-photo-id="270"]')).toBeVisible();
  await page.evaluate(() => {
    window.gallerySequenceGate.skip = 0;
    window.gallerySequenceGate.armed = true;
    const scroll = document.querySelector("[data-masonry-scroll]");
    if (scroll) {
      scroll.scrollTop = scroll.scrollHeight;
    }
  });
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const scroll = document.querySelector("[data-masonry-scroll]");
          if (scroll && window.gallerySequenceGate.held === 0) {
            scroll.scrollTop = scroll.scrollTop > 0 ? 0 : scroll.scrollHeight;
          }
          return window.gallerySequenceGate.held;
        }),
      {
        timeout: 20_000,
      }
    )
    .toBe(1);
  const pendingRequests = await page.evaluate(
    () => window.gallerySequenceGate.sequenceRequests
  );
  // Keep the sentinel visible beyond its debounce interval: unconfirmed
  // ownership must not start another search page behind the held response.
  await page.evaluate(
    () => new Promise<void>((resolve) => setTimeout(resolve, 600))
  );
  expect(
    await page.evaluate(() => window.gallerySequenceGate.sequenceRequests)
  ).toBe(pendingRequests);
  const cards = page.locator("[data-photo-id]");
  await expect(cards.first()).toBeVisible();
  const before = await cards.evaluateAll((nodes) =>
    nodes.map((node) => Number(node.getAttribute("data-photo-id")))
  );
  expect(before.every((id) => !GROUP_IDS.includes(id))).toBe(true);
  await page.evaluate(() => window.gallerySequenceGate.release(true));
  await expect(
    page.getByRole("button", { name: "Retry", exact: true })
  ).toBeVisible();
  expect(
    await cards.evaluateAll((nodes) =>
      nodes.map((node) => Number(node.getAttribute("data-photo-id")))
    )
  ).toEqual(before);
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Retry", exact: true })
  ).toHaveCount(0);
  await expect(cards.first()).toBeVisible();
  for (const id of GROUP_IDS) {
    await expect(page.locator(`[data-photo-id="${id}"]`)).toHaveCount(0);
  }
});

for (const size of SIZES) {
  test(`${size.width}x${size.height} discovers matching sequences beyond the first search page`, async () => {
    await app.evaluate(
      ({ BrowserWindow }, requested) =>
        BrowserWindow.getAllWindows()[0].setSize(
          requested.width,
          requested.height
        ),
      size
    );
    await navigate("/albums/9001");
    await page.locator(".page-toolbar").waitFor();
    await navigate("/");
    await page.getByRole("button", { name: "Photos", exact: true }).click();
    const searches = await page.evaluate(
      () => window.gallerySequenceGate.searches
    );
    await navigate("/?cameraModel=GalleryFixture");
    await expect
      .poll(() => page.evaluate(() => window.gallerySequenceGate.searches))
      .toBeGreaterThan(searches);
    await page.getByRole("button", { name: SEQUENCES }).click();
    await expect(page.locator("[data-sequence-id]")).toHaveCount(3);
    await page.getByRole("button", { name: "Photos", exact: true }).click();
    await expect(page.locator(".home-gallery-toolbar-layer")).toBeVisible();
    for (const id of GROUP_IDS) {
      await expect(page.locator(`[data-photo-id="${id}"]`)).toHaveCount(0);
    }
    await expect(page.locator("[data-masonry-scroll]")).toBeVisible();
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth >
          document.documentElement.clientWidth + 2
      )
    ).toBe(false);
  });
}
