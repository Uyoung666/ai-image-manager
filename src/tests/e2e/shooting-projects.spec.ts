import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { type ElectronApplication, expect, type Page } from "@playwright/test";
import sharp from "sharp";
import { waitForHomeWindow } from "./helpers/home-window";
import { createTestRuntime, launchTestApp, test } from "./helpers/test-runtime";

const electronPath = createRequire(import.meta.url)("electron") as string;
const SIZES = [
  { width: 720, height: 480 },
  { width: 900, height: 600 },
  { width: 1280, height: 800 },
] as const;

interface Fixture {
  app?: ElectronApplication;
  env: Record<string, string>;
  hook: string;
  profile: string;
  root: string;
  sourceFile: string;
  sourceRoot: string;
}

interface ProjectRow {
  id: string;
  name: string;
  source_root: string;
  source_status: string;
}

interface QueueEvent {
  channel: string;
  payload: {
    current?: unknown;
    history?: unknown[];
    pending?: unknown[];
    total?: number;
  };
}

async function createFixture(owner: string): Promise<Fixture> {
  const root = createTestRuntime(owner);
  const profile = path.join(root, "profile");
  const scratch = path.join(root, "scratch");
  const sourceRoot = path.join(
    root,
    "储存卡模拟",
    "秋日外拍照片与中文长来源目录名称布局检查"
  );
  const sourceFile = path.join(sourceRoot, "子目录", "原片-001.png");
  fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
  fs.mkdirSync(scratch, { recursive: true });
  await sharp({
    create: { width: 160, height: 100, channels: 3, background: "#287ab1" },
  })
    .png()
    .toFile(sourceFile);
  const hook = path.join(root, "isolation.cjs");
  fs.writeFileSync(
    hook,
    `const {app,shell}=require('electron');
const fs=require('node:fs');const path=require('node:path');
shell.openPath=async target=>{fs.appendFileSync(path.join(__dirname,'opened-output.jsonl'),JSON.stringify(target)+'\\n');return '';};
app.setAppPath(${JSON.stringify(path.resolve("."))});
for(const [key,part] of Object.entries({appData:'appdata',cache:'cache',userData:'profile',sessionData:'profile',temp:'scratch',logs:'logs',crashDumps:'crashes'})){const p=path.join(__dirname,part);fs.mkdirSync(p,{recursive:true});app.setPath(key,p);}
app.on('web-contents-created',(_event,contents)=>{const send=contents.send.bind(contents);contents.send=(channel,...args)=>{if(channel==='import-queue-status'||channel==='ai-progress'){fs.appendFileSync(path.join(__dirname,'queue-events.jsonl'),JSON.stringify({channel,payload:args[0]})+'\\n');}return send(channel,...args);};});`
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
      TEMP: scratch,
      TMP: scratch,
    }).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
  return { env, hook, profile, root, sourceFile, sourceRoot };
}

async function launch(fixture: Fixture): Promise<Page> {
  fixture.app = await launchTestApp(fixture.root, {
    args: [
      "--no-sandbox",
      "--disable-gpu-sandbox",
      "--enable-unsafe-swiftshader",
      "--use-angle=swiftshader",
      "-r",
      fixture.hook,
      "--e2e",
      process.env.AIM_E2E_APP_PATH ?? path.resolve("."),
    ],
    env: fixture.env,
  });
  const page = await waitForHomeWindow(fixture.app);
  await page.addInitScript(() => localStorage.setItem("lang", "en"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => Boolean(window.__e2eNavigate));
  return page;
}

async function close(fixture: Fixture): Promise<void> {
  await fixture.app?.close();
  fixture.app = undefined;
}

function database<Row>(fixture: Fixture, sql: string): Row[] {
  return JSON.parse(
    execFileSync(
      electronPath,
      [
        "-e",
        "const D=require('better-sqlite3');const d=new D(process.argv[1],{readonly:true});try{console.log(JSON.stringify(d.prepare(process.argv[2]).all()))}finally{d.close()}",
        path.join(fixture.profile, "data", "ai-image-manager.db"),
        sql,
      ],
      {
        env: { ...fixture.env, ELECTRON_RUN_AS_NODE: "1" },
        encoding: "utf8",
      }
    )
  ) as Row[];
}

function execute(fixture: Fixture, sql: string): void {
  execFileSync(
    electronPath,
    [
      "-e",
      "const D=require('better-sqlite3');const d=new D(process.argv[1]);try{d.exec(require('node:fs').readFileSync(0,'utf8'))}finally{d.close()}",
      path.join(fixture.profile, "data", "ai-image-manager.db"),
    ],
    {
      env: { ...fixture.env, ELECTRON_RUN_AS_NODE: "1" },
      input: sql,
      encoding: "utf8",
    }
  );
}

function librarySnapshot(fixture: Fixture) {
  return database(
    fixture,
    `SELECT
    (SELECT COUNT(*) FROM photos) AS photos,
    (SELECT COUNT(*) FROM folders) AS folders,
    (SELECT COUNT(*) FROM albums) AS albums,
    (SELECT COUNT(*) FROM cull_sessions WHERE project_id IS NULL) AS sessions,
    (SELECT COUNT(*) FROM photos WHERE is_ai_processed = 1) AS aiProcessed,
    (SELECT value FROM app_settings WHERE key = 'imports.unfinishedRoots') AS unfinishedImports`
  );
}

function expectNoProjectImports(fixture: Fixture): void {
  const eventsFile = path.join(fixture.root, "queue-events.jsonl");
  const events: QueueEvent[] = fs.existsSync(eventsFile)
    ? fs
        .readFileSync(eventsFile, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as QueueEvent)
    : [];
  for (const event of events) {
    if (event.channel === "import-queue-status") {
      expect(event.payload.current).toBeNull();
      expect(event.payload.pending).toEqual([]);
      expect(event.payload.history).toEqual([]);
    } else {
      expect(event.payload.total ?? 0).toBe(0);
    }
  }
}

async function navigateToCull(page: Page): Promise<void> {
  await page.evaluate(() => window.__e2eNavigate?.("/cull"));
  await expect(page.getByTestId("cull-open-folder")).toBeVisible();
}

async function choosePath(fixture: Fixture, folder: string): Promise<void> {
  await fixture.app?.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [selected],
    });
  }, folder);
}

async function openFolder(
  fixture: Fixture,
  page: Page,
  workflow: "curate" | "duel" | "hybrid" = "curate"
): Promise<string> {
  await choosePath(fixture, fixture.sourceRoot);
  await page.getByTestId("cull-open-folder").click();
  await page.getByTestId(`shooting-workflow-${workflow}`).check();
  await page.getByTestId("shooting-project-create-submit").click();
  await expect(page.getByTestId("shooting-project-workspace")).toBeVisible();
  const [project] = database<ProjectRow>(
    fixture,
    "SELECT id,name,source_root,source_status FROM shooting_projects ORDER BY created_at DESC LIMIT 1"
  );
  expect(project.name).toBe(path.basename(fixture.sourceRoot));
  return project.id;
}

interface ProjectPhoto {
  id: string;
  preview_status: string;
  preview_width: number;
  relative_path: string;
  source_status: string;
  status: string;
  width: number;
}

function projectPhotos(fixture: Fixture): ProjectPhoto[] {
  return database<ProjectPhoto>(
    fixture,
    "SELECT id,relative_path,status,preview_status,source_status,preview_width,width FROM shooting_project_photos ORDER BY relative_path"
  );
}

async function addPhotos(fixture: Fixture): Promise<void> {
  for (let index = 2; index <= 4; index++) {
    await sharp({
      create: {
        width: 160 + index,
        height: 100,
        channels: 3,
        background: index % 2 ? "#b14a28" : "#28b15a",
      },
    })
      .png()
      .toFile(path.join(fixture.sourceRoot, `photo-${index}.png`));
  }
}

async function waitPrepared(fixture: Fixture, count: number): Promise<void> {
  await expect
    .poll(
      () => {
        const rows = projectPhotos(fixture);
        return {
          count: rows.length,
          ready: rows.filter((photo) => photo.preview_status === "ready")
            .length,
          available: rows.filter((photo) => photo.source_status === "available")
            .length,
          scan: database<{ scan_status: string }>(
            fixture,
            "SELECT scan_status FROM shooting_projects"
          )[0]?.scan_status,
        };
      },
      { timeout: 60_000 }
    )
    .toEqual({ count, ready: count, available: count, scan: "completed" });
}

async function keepAll(
  fixture: Fixture,
  page: Page,
  count: number
): Promise<void> {
  await page.getByTestId("shooting-tab-curate").click();
  for (let kept = 1; kept <= count; kept++) {
    await expect(page.getByTestId("cull-curate-keep")).toBeEnabled();
    await page.keyboard.press("ArrowRight");
    await expect
      .poll(
        () =>
          projectPhotos(fixture).filter((photo) => photo.status === "kept")
            .length
      )
      .toBe(kept);
  }
}

async function expectPreview(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page
          .getByTestId("shooting-project-workspace")
          .locator("img")
          .evaluateAll((images) =>
            images.some(
              (image) =>
                (image as HTMLImageElement).complete &&
                (image as HTMLImageElement).naturalWidth > 0
            )
          ),
      { timeout: 60_000 }
    )
    .toBe(true);
}

async function expectLayoutInsideViewport(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() =>
        [
          document.documentElement,
          document.body,
          ...document.querySelectorAll(
            "main, [role='dialog'], [data-slot='popover-content']"
          ),
        ]
          .filter((element) => element.getClientRects().length > 0)
          .map((element) => {
            const rect = element.getBoundingClientRect();
            return {
              name: element.tagName,
              horizontalOverflow: element.scrollWidth - element.clientWidth,
              left: rect.left,
              right: rect.right,
              top: rect.top,
              bottom: rect.bottom,
            };
          })
          .filter(
            (entry) =>
              entry.horizontalOverflow > 2 ||
              entry.left < -2 ||
              entry.right > innerWidth + 2 ||
              entry.top < -2 ||
              entry.bottom > innerHeight + 2
          )
      )
    )
    .toEqual([]);
  // Root dimensions alone miss controls clipped by a header or navigation row.
  if (await page.getByRole("dialog").count()) {
    return;
  }
  const controls = page
    .getByTestId("shooting-project-workspace")
    .locator(":scope > header, :scope > nav")
    .locator("button, a, input, [role='combobox']");
  for (let index = 0; index < (await controls.count()); index++) {
    const control = controls.nth(index);
    if (!(await control.isVisible())) {
      continue;
    }
    // Explicit internal scrolling is allowed, but every action must be reachable.
    await control.scrollIntoViewIfNeeded();
    await expect(control).toBeInViewport({ ratio: 1 });
  }
}

async function screenshot(
  fixture: Fixture,
  page: Page,
  filename: string
): Promise<void> {
  await page.mouse.move(1, 1);
  await expect(page.locator('[data-slot="tooltip-content"]')).toHaveCount(0);
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0, {
    timeout: 15_000,
  });
  await page.evaluate(async () => {
    const finiteAnimations = document
      .getAnimations()
      .filter(
        (animation) =>
          animation.effect?.getComputedTiming().iterations !==
          Number.POSITIVE_INFINITY
      );
    await Promise.allSettled(
      finiteAnimations.map((animation) => animation.finished)
    );
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    );
  });
  if (!fixture.app) {
    throw new Error("Cannot capture a closed app");
  }
  const capture = await fixture.app.evaluate(async ({ BrowserWindow }, url) => {
    const window = BrowserWindow.getAllWindows().find(
      (entry) => entry.webContents.getURL() === url
    );
    if (!window) {
      throw new Error("Main renderer window was not found");
    }
    const image = await window.capturePage();
    return {
      image: image.toPNG().toString("base64"),
      size: window.getContentSize(),
    };
  }, page.url());
  const bytes = Buffer.from(capture.image, "base64");
  const dimensions = await sharp(bytes).metadata();
  expect({ width: dimensions.width, height: dimensions.height }).toEqual({
    width: capture.size[0],
    height: capture.size[1],
  });
  fs.writeFileSync(test.info().outputPath(filename), bytes);
}

async function resize(
  fixture: Fixture,
  page: Page,
  size: { width: number; height: number },
  zoom = 1
): Promise<void> {
  await fixture.app?.evaluate(
    ({ BrowserWindow }, requested) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.setContentSize(requested.width, requested.height);
      window.webContents.setZoomFactor(requested.zoom);
    },
    { ...size, zoom }
  );
  await expect
    .poll(() =>
      page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
    )
    .toEqual({ width: size.width / zoom, height: size.height / zoom });
}

async function startSelectedPk(page: Page): Promise<void> {
  await page.getByTestId("shooting-tab-result").click();
  const cards = page.getByTestId("cull-result-card");
  await cards.nth(0).click();
  await cards.nth(1).click({ modifiers: ["Control"] });
  await page.getByTestId("cull-start-selected-pk").click();
  await page.getByTestId("shooting-pk-start").click();
  await expect(page.getByTestId("cull-duel-left")).toBeVisible();
}

test.setTimeout(150_000);

test("offers three workflows, completes PK into one result view and separates settings archives", async () => {
  const fixture = await createFixture("shooting-three-workflows");
  await sharp({
    create: { width: 170, height: 100, channels: 3, background: "#b14a28" },
  })
    .png()
    .toFile(path.join(fixture.sourceRoot, "second.png"));
  try {
    const page = await launch(fixture);
    const projects: string[] = [];
    for (const workflow of ["curate", "duel", "hybrid"] as const) {
      await navigateToCull(page);
      await choosePath(fixture, fixture.sourceRoot);
      await page.getByTestId("cull-open-folder").click();
      await page.getByTestId(`shooting-workflow-${workflow}`).check();
      if (workflow === "hybrid") {
        await page
          .getByTestId("shooting-create-pk-mode")
          .getByRole("combobox")
          .click();
        await page
          .getByRole("option", { name: "Quick Filter", exact: true })
          .click();
      }
      for (const size of SIZES) {
        await resize(fixture, page, size);
        await expectLayoutInsideViewport(page);
      }
      await resize(fixture, page, SIZES[0], 1.25);
      await expectLayoutInsideViewport(page);
      if (workflow === "curate") {
        await screenshot(fixture, page, "workflow-presets.png");
      }
      await page.getByTestId("shooting-project-create-submit").click();
      await expect(
        page.getByTestId("shooting-project-workspace")
      ).toBeVisible();
      await expect
        .poll(
          () =>
            database(
              fixture,
              "SELECT id FROM shooting_project_photos WHERE preview_status='ready'"
            ).length
        )
        .toBe((projects.length + 1) * 2);
      const [project] = database<{ id: string; workflow: string }>(
        fixture,
        "SELECT id,workflow FROM shooting_projects ORDER BY created_at DESC LIMIT 1"
      );
      projects.push(project.id);
      expect(project.workflow).toBe(workflow);
      if (workflow === "duel") {
        await expect(page.getByTestId("cull-duel-left")).toBeVisible();
        const [round] = database<{ id: number }>(
          fixture,
          "SELECT id FROM cull_sessions WHERE mode='duel'"
        );
        for (let index = 0; index < 9; index++) {
          await expect(page.getByTestId("cull-duel-left")).toBeEnabled();
          await page.keyboard.press("ArrowLeft");
          await expect
            .poll(
              () =>
                database<{ completed_comparisons: number }>(
                  fixture,
                  `SELECT completed_comparisons FROM cull_sessions WHERE id=${round.id}`
                )[0].completed_comparisons
            )
            .toBe(index + 1);
        }
        await expect(page.getByTestId("shooting-tab-result")).toHaveAttribute(
          "aria-pressed",
          "true"
        );
        await expect(page.getByTestId("cull-top-n-input")).toBeVisible();
        await page.getByTestId("shooting-tab-duel").click();
        await expect(
          page.getByText(
            "This round is complete. View its ranking or start a new round."
          )
        ).toBeVisible();
        await expect(page.getByTestId("cull-duel-left")).toHaveCount(0);
        expect(
          database(fixture, "SELECT id FROM cull_sessions WHERE mode='duel'")
        ).toHaveLength(1);
        await page.getByTestId("shooting-pk-results").click();
        await page.getByTestId("cull-top-n-input").fill("1");
        await page.getByTestId("cull-top-n-apply").click();
        await page.getByTestId("cull-top-n-confirm").click();
        await expect(page.getByTestId("cull-result-card")).toHaveCount(1);
        await expect(page.getByTestId("cull-top-n-input")).toBeVisible();
        await screenshot(fixture, page, "unified-results.png");
      } else {
        for (let index = 0; index < 2; index++) {
          await expect(page.getByTestId("cull-curate-keep")).toBeEnabled();
          await page.keyboard.press("ArrowRight");
          await expect
            .poll(
              () =>
                database(
                  fixture,
                  `SELECT id FROM shooting_project_photos WHERE project_id='${project.id}' AND status='kept'`
                ).length
            )
            .toBe(index + 1);
        }
        if (workflow === "hybrid") {
          await expect(page.getByTestId("cull-duel-left")).toBeVisible();
          expect(
            database<{ pk_mode: string }>(
              fixture,
              `SELECT pk_mode FROM cull_sessions WHERE project_id='${project.id}' AND mode='duel'`
            )[0].pk_mode
          ).toBe("quick");
          expect(
            database<{ pk_mode: string }>(
              fixture,
              `SELECT pk_mode FROM shooting_projects WHERE id='${project.id}'`
            )[0].pk_mode
          ).toBe("quick");
        }
      }
    }
    execute(
      fixture,
      `UPDATE shooting_projects SET archived_at=123 WHERE id='${projects[0]}'; INSERT INTO cull_sessions(name,mode,status,created_at) VALUES('Library finished','curate','completed',1);`
    );
    await navigateToCull(page);
    await expect(page.getByText("Library finished")).toBeVisible();
    for (const size of SIZES) {
      await resize(fixture, page, size);
      await expectLayoutInsideViewport(page);
    }
    const searchBox = await page.getByRole("searchbox").boundingBox();
    const openBox = await page.getByTestId("cull-open-folder").boundingBox();
    expect(
      searchBox && openBox && searchBox.x + searchBox.width < openBox.x
    ).toBeTruthy();
    await expect(
      page.getByRole("combobox", { name: "Project list" })
    ).toHaveCount(0);
    await screenshot(fixture, page, "list-header.png");
    await page.evaluate(() => window.__e2eNavigate?.("/settings/cull-archive"));
    await expect(
      page.getByRole("heading", { name: "Archived culling" })
    ).toBeVisible();
    await expect(page.getByTestId("shooting-project-card")).toHaveCount(1);
    await expect(page.getByText("Library finished")).toHaveCount(0);
    await page.getByRole("searchbox").fill("nothing matches");
    await expect(page.getByText("No matching culling records")).toBeVisible();
    await expect(page.getByTestId("shooting-project-card")).toHaveCount(0);
    expectNoProjectImports(fixture);
  } finally {
    await close(fixture);
  }
});

test("archives both task sources with undo, unified cards and an import-free sidebar shortcut", async () => {
  const fixture = await createFixture("shooting-task-archives");
  try {
    const page = await launch(fixture);
    await choosePath(fixture, fixture.sourceRoot);
    await page
      .getByRole("button", { name: "Cull without importing", exact: true })
      .click();
    await page.getByTestId("shooting-workflow-curate").check();
    await page.getByTestId("shooting-project-create-submit").click();
    await expect(page.getByTestId("shooting-project-workspace")).toBeVisible();
    await waitPrepared(fixture, 1);
    const [project] = database<ProjectRow>(
      fixture,
      "SELECT id,name,source_root,source_status FROM shooting_projects LIMIT 1"
    );
    await page.getByTestId("cull-curate-keep").click();
    await expect.poll(() => projectPhotos(fixture)[0]?.status).toBe("kept");
    await page.getByTestId(`cull-archive-project-${project.id}`).click();
    await expect(page.getByTestId("cull-open-folder")).toBeVisible();
    await expect(page.getByTestId("shooting-project-card")).toHaveCount(0);
    await page
      .locator("[data-sonner-toast]")
      .filter({ hasText: "Archived “" })
      .last()
      .getByRole("button", { name: "Undo", exact: true })
      .click();
    await expect(page.getByTestId("shooting-project-card")).toHaveCount(1);
    execute(
      fixture,
      "INSERT INTO cull_sessions(name,mode,status,created_at,completed_at,completed_comparisons) VALUES('Library archive task','curate','completed',1,2,9);"
    );
    const [library] = database<{ id: number }>(
      fixture,
      "SELECT id FROM cull_sessions WHERE project_id IS NULL LIMIT 1"
    );
    await page.evaluate(() => window.__e2eNavigate?.("/"));
    await navigateToCull(page);
    const projectCard = page.getByTestId("shooting-project-card");
    const libraryCard = page.getByTestId("cull-library-card");
    await expect(libraryCard).toBeVisible();
    expect(await libraryCard.getAttribute("class")).toBe(
      await projectCard.getAttribute("class")
    );
    for (const size of SIZES) {
      await resize(fixture, page, size);
      await expectLayoutInsideViewport(page);
      const boxes = await Promise.all([
        projectCard.boundingBox(),
        libraryCard.boundingBox(),
      ]);
      expect(
        boxes[0] && boxes[1] && Math.abs(boxes[0].height - boxes[1].height) < 2
      ).toBeTruthy();
    }
    await screenshot(fixture, page, "unified-task-cards.png");
    await page.getByTestId(`cull-archive-library-${library.id}`).click();
    await expect(libraryCard).toHaveCount(0);
    await expect(projectCard).toBeVisible();
    await expect(page.getByTestId("cull-open-folder")).toBeVisible();
    await page.getByTestId(`cull-archive-project-${project.id}`).click();
    await expect(projectCard).toHaveCount(0);
    await page.evaluate(() => window.__e2eNavigate?.("/settings/appearance"));
    await page
      .getByRole("button", { name: "Archived culling", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Archived culling" })
    ).toBeVisible();
    await expect(libraryCard).toBeVisible();
    await expect(projectCard).toBeVisible();
    for (const size of SIZES) {
      await resize(fixture, page, size);
      await expectLayoutInsideViewport(page);
    }
    await fixture.app?.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((window) => window.isVisible())
        ?.webContents.setZoomFactor(1.25)
    );
    await resize(fixture, page, SIZES[0]);
    await expectLayoutInsideViewport(page);
    await fixture.app?.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((window) => window.isVisible())
        ?.webContents.setZoomFactor(1)
    );
    await resize(fixture, page, SIZES[2]);
    await screenshot(fixture, page, "settings-task-archives.png");
    await page.getByRole("searchbox").fill("Library archive");
    await expect(projectCard).toHaveCount(0);
    await expect(libraryCard).toBeVisible();
    await page.getByTestId(`cull-archive-library-${library.id}`).click();
    await expect(libraryCard).toHaveCount(0);
    await page.getByRole("searchbox").fill("");
    await projectCard
      .getByRole("button", { name: `Open culling task: ${project.name}` })
      .click();
    await expect(page.getByTestId("shooting-project-workspace")).toBeVisible();
    await expect(
      page.getByTestId(`cull-archive-project-${project.id}`)
    ).toHaveAttribute("aria-label", "Restore to culling list");
    expect(projectPhotos(fixture)[0].status).toBe("kept");
    await page.getByTestId(`cull-archive-project-${project.id}`).click();
    await expect(
      page.getByTestId(`cull-archive-project-${project.id}`)
    ).toHaveAttribute("aria-label", "Archive culling task");
    await page
      .locator("[data-sonner-toast]")
      .filter({ hasText: "Restored “" })
      .last()
      .getByRole("button", { name: "Undo", exact: true })
      .click();
    await expect(
      page.getByTestId(`cull-archive-project-${project.id}`)
    ).toHaveAttribute("aria-label", "Restore to culling list");
    await page.getByTestId(`cull-archive-project-${project.id}`).click();
    await expect(
      page.getByTestId(`cull-archive-project-${project.id}`)
    ).toHaveAttribute("aria-label", "Archive culling task");
    await navigateToCull(page);
    await libraryCard
      .getByRole("button", { name: "Open culling task: Library archive task" })
      .click();
    await expect(
      page.getByTestId(`cull-archive-library-${library.id}`)
    ).toBeVisible();
    await page.getByTestId(`cull-archive-library-${library.id}`).click();
    await expect(page.getByTestId("cull-open-folder")).toBeVisible();
    const [saved] = database<{
      status: string;
      completed_comparisons: number;
      completed_at: number;
      archived_at: number;
    }>(
      fixture,
      `SELECT status,completed_comparisons,completed_at,archived_at FROM cull_sessions WHERE id=${library.id}`
    );
    expect(saved).toMatchObject({
      status: "completed",
      completed_comparisons: 9,
      completed_at: 2,
      archived_at: expect.any(Number),
    });
    expect(database(fixture, "SELECT id FROM photos")).toHaveLength(0);
    expectNoProjectImports(fixture);
  } finally {
    await close(fixture);
  }
});

test("hybrid review feeds only keepers to PK and final selection retains PK ranks after Top N and restart", async () => {
  const fixture = await createFixture("shooting-hybrid-ranking");
  for (let index = 2; index <= 8; index++) {
    await sharp({
      create: {
        width: 160 + index,
        height: 100,
        channels: 3,
        background: index % 2 ? "#b14a28" : "#28b15a",
      },
    })
      .png()
      .toFile(path.join(fixture.sourceRoot, `photo-${index}.png`));
  }
  try {
    let page = await launch(fixture);
    await navigateToCull(page);
    const projectId = await openFolder(fixture, page, "hybrid");
    await waitPrepared(fixture, 8);
    for (let index = 0; index < 7; index++) {
      await expect(page.getByTestId("cull-curate-keep")).toBeEnabled();
      await page.keyboard.press(index < 5 ? "ArrowRight" : "ArrowLeft");
      await expect
        .poll(
          () =>
            projectPhotos(fixture).filter((photo) => photo.status !== "pending")
              .length
        )
        .toBe(index + 1);
    }
    await page.getByTestId("cull-curate-current").hover();
    await page.getByRole("button", { name: "Finish", exact: true }).click();
    await page
      .getByRole("button", { name: "Finish review and enter PK", exact: true })
      .click();
    await expect(page.getByTestId("cull-duel-left")).toBeVisible();
    const [round] = database<{ id: number }>(
      fixture,
      "SELECT id FROM cull_sessions WHERE mode='duel'"
    );
    expect(
      database(
        fixture,
        `SELECT id FROM cull_session_photos WHERE session_id=${round.id}`
      )
    ).toHaveLength(5);
    await page.keyboard.press("ArrowRight");
    await expect
      .poll(
        () =>
          database<{ completed_comparisons: number }>(
            fixture,
            `SELECT completed_comparisons FROM cull_sessions WHERE id=${round.id}`
          )[0].completed_comparisons
      )
      .toBe(1);
    // Deterministic scores intentionally reverse the first-pass file order.
    execute(
      fixture,
      `UPDATE cull_session_photos SET rating=1000+id*11 WHERE session_id=${round.id};`
    );
    await page.getByTestId("cull-duel-left").hover();
    await page.getByRole("button", { name: "Finish", exact: true }).click();
    await page
      .getByRole("button", { name: "Finish and view results", exact: true })
      .click();
    const cards = page.getByTestId("cull-result-card");
    await expect(cards).toHaveCount(5);
    const readRanked = () =>
      cards.evaluateAll((items) =>
        items.map((item) => ({
          photo: item.getAttribute("data-photo-id"),
          rank: item.getAttribute("data-rank"),
          elo: item.getAttribute("data-rating"),
        }))
      );
    const pkRanking = await readRanked();
    expect(pkRanking.map((row) => row.rank)).toEqual(["1", "2", "3", "4", "5"]);
    await page.getByTestId("shooting-tab-result").click();
    await expect.poll(readRanked).toEqual(pkRanking);
    await page.getByTestId("cull-top-n-input").fill("3");
    await page.getByTestId("cull-top-n-apply").click();
    await page.getByTestId("cull-top-n-confirm").click();
    await expect.poll(readRanked).toEqual(pkRanking.slice(0, 3));
    for (const size of SIZES) {
      await resize(fixture, page, size);
      await expectLayoutInsideViewport(page);
    }
    await screenshot(fixture, page, "hybrid-final-ranked.png");
    await resize(fixture, page, SIZES[0], 1.25);
    await expectLayoutInsideViewport(page);
    await close(fixture);
    page = await launch(fixture);
    await navigateToCull(page);
    await page.locator(`[data-project-id="${projectId}"]`).click();
    await expect
      .poll(() =>
        page.getByTestId("cull-result-card").evaluateAll((items) =>
          items.map((item) => ({
            photo: item.getAttribute("data-photo-id"),
            rank: item.getAttribute("data-rank"),
            elo: item.getAttribute("data-rating"),
          }))
        )
      )
      .toEqual(pkRanking.slice(0, 3));
    expect(
      projectPhotos(fixture).filter((photo) => photo.status === "kept")
    ).toHaveLength(3);
    expect(
      projectPhotos(fixture).filter((photo) => photo.status === "pending")
    ).toHaveLength(1);
    expectNoProjectImports(fixture);
  } finally {
    await close(fixture);
  }
});

test("reuses curate and PK with usable results and copy dialogs at every supported viewport", async () => {
  const fixture = await createFixture("shooting-cull-responsive");
  await addPhotos(fixture);
  try {
    const page = await launch(fixture);
    const before = librarySnapshot(fixture);
    await navigateToCull(page);
    await expect(
      page.getByRole("button", { name: "Shooting projects", exact: true })
    ).toHaveCount(0);
    await openFolder(fixture, page);
    await waitPrepared(fixture, 4);
    await expectPreview(page);
    for (const size of SIZES) {
      await resize(fixture, page, size);
      await expectLayoutInsideViewport(page);
      await screenshot(
        fixture,
        page,
        `curate-${size.width}x${size.height}.png`
      );
    }
    await keepAll(fixture, page, 4);
    await startSelectedPk(page);
    for (const size of SIZES) {
      await resize(fixture, page, size);
      await expectLayoutInsideViewport(page);
      await screenshot(fixture, page, `pk-${size.width}x${size.height}.png`);
      await page.getByTestId("shooting-pk-new").click();
      await expect(page.getByTestId("shooting-pk-start")).toBeVisible();
      await expectLayoutInsideViewport(page);
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Cancel", exact: true })
        .click();
      await page.getByTestId("shooting-source-details").click();
      await expect(page.getByTestId("shooting-relink")).toBeVisible();
      await expectLayoutInsideViewport(page);
      await page.keyboard.press("Escape");
      await page.getByTestId("shooting-tab-result").click();
      await expectLayoutInsideViewport(page);
      await page.getByTestId("shooting-copy-kept").click();
      await choosePath(fixture, fixture.root);
      await page.getByTestId("shooting-output-choose").click();
      await expect(page.getByTestId("shooting-output-confirm")).toBeEnabled();
      await expectLayoutInsideViewport(page);
      await screenshot(fixture, page, `copy-${size.width}x${size.height}.png`);
      await page
        .getByTestId("shooting-output-dialog")
        .getByRole("button", { name: "Cancel", exact: true })
        .click();
      await page.getByTestId("shooting-tab-duel").click();
    }
    await resize(fixture, page, SIZES[0], 1.25);
    await expectLayoutInsideViewport(page);
    await page.getByTestId("shooting-tab-result").click();
    await expectLayoutInsideViewport(page);
    await screenshot(fixture, page, "results-125-percent.png");
    await page.getByTestId("shooting-source-details").click();
    await expect(page.getByTestId("shooting-relink")).toBeVisible();
    await expectLayoutInsideViewport(page);
    await page.keyboard.press("Escape");
    await page.getByTestId("shooting-project-manage").click();
    await expect(page.getByTestId("shooting-project-rename")).toBeInViewport({
      ratio: 1,
    });
    await expectLayoutInsideViewport(page);
    await page.keyboard.press("Escape");
    await page.getByTestId("shooting-copy-kept").click();
    await choosePath(fixture, fixture.root);
    await page.getByTestId("shooting-output-choose").click();
    await expect(page.getByTestId("shooting-output-confirm")).toBeEnabled();
    await expectLayoutInsideViewport(page);
    await screenshot(fixture, page, "copy-125-percent.png");
    await page
      .getByTestId("shooting-output-dialog")
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    await navigateToCull(page);
    await expect(page.getByTestId("shooting-project-card")).toHaveCount(1);
    await expectLayoutInsideViewport(page);
    expect(librarySnapshot(fixture)).toEqual(before);
    expectNoProjectImports(fixture);
  } finally {
    await close(fixture);
  }
});

test("curates, compares a kept subset and copies only final originals with XMP without ZIP or AI", async () => {
  const fixture = await createFixture("shooting-cull-workflow");
  await addPhotos(fixture);
  const output = path.join(fixture.root, "修图输出");
  fs.mkdirSync(output);
  const originalFiles = [
    fixture.sourceFile,
    ...[2, 3, 4].map((index) =>
      path.join(fixture.sourceRoot, `photo-${index}.png`)
    ),
  ];
  for (const original of originalFiles) {
    fs.writeFileSync(
      `${original.slice(0, -4)}.xmp`,
      '<x:xmpmeta xmlns:x="adobe:ns:meta/">original sidecar</x:xmpmeta>'
    );
  }
  try {
    const page = await launch(fixture);
    const before = librarySnapshot(fixture);
    await navigateToCull(page);
    const projectId = await openFolder(fixture, page);
    await waitPrepared(fixture, 4);
    await keepAll(fixture, page, 4);
    await startSelectedPk(page);
    const [round] = database<{ id: number }>(
      fixture,
      "SELECT id FROM cull_sessions WHERE mode='duel'"
    );
    expect(
      database(
        fixture,
        `SELECT id FROM cull_session_photos WHERE session_id=${round.id}`
      )
    ).toHaveLength(2);
    await page.keyboard.press("ArrowLeft");
    await expect
      .poll(
        () =>
          database<{ completed_comparisons: number }>(
            fixture,
            "SELECT completed_comparisons FROM cull_sessions WHERE id=" +
              round.id
          )[0].completed_comparisons
      )
      .toBe(1);
    expect(
      projectPhotos(fixture).every((photo) => photo.status === "kept")
    ).toBe(true);
    await page.getByTestId("shooting-pk-results").click();
    await page.getByTestId("cull-top-n-input").fill("1");
    await page.getByTestId("cull-top-n-apply").click();
    await expectLayoutInsideViewport(page);
    await page.getByTestId("cull-top-n-confirm").click();
    await expect
      .poll(
        () =>
          projectPhotos(fixture).filter((photo) => photo.status === "kept")
            .length
      )
      .toBe(3);
    const saved = projectPhotos(fixture).map(({ id, status }) => ({
      id,
      status,
    }));
    await page.getByTestId("shooting-copy-kept").click();
    await choosePath(fixture, output);
    await page.getByTestId("shooting-output-choose").click();
    await page.getByTestId("shooting-output-confirm").click();
    await expect
      .poll(
        () =>
          database<{ status: string }>(
            fixture,
            "SELECT status FROM shooting_project_outputs"
          )[0]?.status,
        { timeout: 60_000 }
      )
      .toBe("completed");
    const items = database<{
      kind: string;
      source_path: string;
      target_path: string;
      sha256: string;
    }>(
      fixture,
      "SELECT kind,source_path,target_path,sha256 FROM shooting_project_output_items"
    );
    expect(items.filter((item) => item.kind === "original")).toHaveLength(3);
    expect(items.filter((item) => item.kind === "xmp")).toHaveLength(3);
    for (const item of items) {
      const digest = (filename: string) =>
        createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
      expect(digest(item.target_path)).toBe(item.sha256);
      expect(digest(item.target_path)).toBe(digest(item.source_path));
      expect(path.extname(item.target_path)).not.toBe(".zip");
    }
    expect(librarySnapshot(fixture)).toEqual(before);
    expectNoProjectImports(fixture);
    await screenshot(fixture, page, "direct-original-handoff.png");
    await close(fixture);
    const reopened = await launch(fixture);
    await navigateToCull(reopened);
    await reopened.locator(`[data-project-id="${projectId}"]`).click();
    await expect(
      reopened.getByTestId("shooting-project-workspace")
    ).toBeVisible();
    expect(
      projectPhotos(fixture).map(({ id, status }) => ({ id, status }))
    ).toEqual(saved);
    expect(
      database<{ completed_comparisons: number }>(
        fixture,
        `SELECT completed_comparisons FROM cull_sessions WHERE id=${round.id}`
      )[0].completed_comparisons
    ).toBe(1);
    await startSelectedPk(reopened);
    expect(
      database(fixture, "SELECT id FROM cull_sessions WHERE mode='duel'")
    ).toHaveLength(2);
    expect(
      projectPhotos(fixture).map(({ id, status }) => ({ id, status }))
    ).toEqual(saved);
    expect(
      database<{ completed_comparisons: number }>(
        fixture,
        `SELECT completed_comparisons FROM cull_sessions WHERE id=${round.id}`
      )[0].completed_comparisons
    ).toBe(1);
  } finally {
    await close(fixture);
  }
});

test("keeps offline decisions and cached results through restart and verified source relink", async () => {
  const fixture = await createFixture("shooting-cull-offline");
  const disconnected = path.join(fixture.root, "reconnected-source");
  try {
    let page = await launch(fixture);
    await navigateToCull(page);
    const projectId = await openFolder(fixture, page);
    await waitPrepared(fixture, 1);
    await keepAll(fixture, page, 1);
    await close(fixture);
    fs.renameSync(fixture.sourceRoot, disconnected);
    page = await launch(fixture);
    await navigateToCull(page);
    await page.locator(`[data-project-id="${projectId}"]`).click();
    await expect(
      page.getByTestId("shooting-project-source-status")
    ).toHaveAttribute("data-status", "offline");
    await page.getByTestId("shooting-tab-result").click();
    await expectPreview(page);
    expect(projectPhotos(fixture)[0].status).toBe("kept");
    await page.getByTestId("shooting-source-details").click();
    await page.getByTestId("shooting-relink").click();
    await choosePath(fixture, disconnected);
    await page.getByTestId("shooting-relink-choose").click();
    await expect(
      page.getByTestId("shooting-relink-dialog").locator("dl")
    ).toBeVisible();
    const acceptance = page.getByTestId("shooting-relink-accept");
    if (await acceptance.isVisible()) {
      await acceptance.check();
    }
    await page.getByTestId("shooting-relink-confirm").click();
    await expect(
      page.getByTestId("shooting-project-source-status")
    ).toHaveAttribute("data-status", "online");
    expect(
      database<{ source_root: string }>(
        fixture,
        "SELECT source_root FROM shooting_projects"
      )[0].source_root
    ).toBe(disconnected);
    expectNoProjectImports(fixture);
  } finally {
    await close(fixture);
  }
});

test("requires acknowledgement for an existing library source at system scaling", async () => {
  const fixture = await createFixture("shooting-cull-library-source");
  try {
    await launch(fixture);
    await close(fixture);
    execute(
      fixture,
      "INSERT INTO folders(path,display_name,photo_count,last_scanned_at,created_at,is_watching) VALUES('" +
        fixture.sourceRoot.replaceAll("'", "''") +
        "','Existing library',0,1,1,0)"
    );
    const page = await launch(fixture);
    await navigateToCull(page);
    await choosePath(fixture, fixture.sourceRoot);
    await page.getByTestId("cull-open-folder").click();
    const acknowledgement = page.getByTestId(
      "shooting-project-library-acknowledgement"
    );
    const submit = page.getByTestId("shooting-project-create-submit");
    await expect(acknowledgement).toBeVisible();
    await expect(submit).toBeDisabled();
    for (const size of SIZES) {
      await resize(fixture, page, size);
      await expectLayoutInsideViewport(page);
      await submit.scrollIntoViewIfNeeded();
      await expect(submit).toBeInViewport();
    }
    await resize(fixture, page, SIZES[0], 1.25);
    await expectLayoutInsideViewport(page);
    expect(database(fixture, "SELECT id FROM shooting_projects")).toEqual([]);
    await acknowledgement.check();
    await submit.click();
    await expect(page.getByTestId("shooting-project-workspace")).toBeVisible();
    expectNoProjectImports(fixture);
  } finally {
    await close(fixture);
  }
});

test("refuses copying into the source and requires acknowledgement for watched output", async () => {
  const fixture = await createFixture("shooting-cull-watched-output");
  const output = path.join(fixture.root, "watched-output");
  fs.mkdirSync(output);
  try {
    await launch(fixture);
    await close(fixture);
    execute(
      fixture,
      "INSERT INTO folders(path,display_name,photo_count,last_scanned_at,created_at,is_watching) VALUES('" +
        output.replaceAll("'", "''") +
        "','Watched output',0,1,1,1)"
    );
    const page = await launch(fixture);
    await navigateToCull(page);
    await openFolder(fixture, page);
    await waitPrepared(fixture, 1);
    await keepAll(fixture, page, 1);
    await page.getByTestId("shooting-copy-kept").click();
    await choosePath(fixture, fixture.sourceRoot);
    await page.getByTestId("shooting-output-choose").click();
    await expect(page.getByTestId("shooting-output-confirm")).toBeDisabled();
    await choosePath(fixture, output);
    await page.getByTestId("shooting-output-choose").click();
    await expect(page.getByTestId("shooting-output-watch-ack")).toBeVisible();
    await expect(page.getByTestId("shooting-output-confirm")).toBeDisabled();
    expect(fs.readdirSync(output)).toEqual([]);
    expect(
      database(fixture, "SELECT id FROM shooting_project_outputs")
    ).toEqual([]);
    await expectLayoutInsideViewport(page);
  } finally {
    await close(fixture);
  }
});

test("displays a real camera RAW and copies its original bytes directly", async () => {
  test.skip(
    !process.env.AIM_SHOOTING_RAW_SAMPLE,
    "requires an explicitly supplied isolated RAW fixture"
  );
  const fixture = await createFixture("shooting-cull-real-raw");
  const sample = process.env.AIM_SHOOTING_RAW_SAMPLE;
  if (!sample) {
    throw new Error("RAW fixture not provided");
  }
  const rawFile = path.join(fixture.sourceRoot, "原片.DNG");
  fs.copyFileSync(sample, rawFile);
  const expectedHash = createHash("sha256")
    .update(fs.readFileSync(rawFile))
    .digest("hex");
  const output = path.join(fixture.root, "raw-output");
  fs.mkdirSync(output);
  try {
    const page = await launch(fixture);
    await navigateToCull(page);
    await openFolder(fixture, page);
    await waitPrepared(fixture, 2);
    await expectPreview(page);
    const raw = projectPhotos(fixture).find((photo) =>
      photo.relative_path.endsWith(".DNG")
    );
    expect(raw?.width).toBeGreaterThan(2560);
    expect(raw?.preview_width).toBeLessThanOrEqual(2560);
    await keepAll(fixture, page, 2);
    await page.getByTestId("shooting-tab-result").click();
    await page.locator(`[data-photo-id="${raw?.id}"]`).dblclick();
    const rawPreview = page
      .getByRole("dialog")
      .getByRole("img", { name: "原片.DNG", exact: true });
    await expect(rawPreview).toBeVisible();
    await expect(page.getByRole("dialog")).toContainText(
      `Preview ${raw?.preview_width} ×`
    );
    await expect(page.getByRole("dialog")).toContainText(
      `original ${raw?.width} ×`
    );
    await expect
      .poll(() =>
        rawPreview.evaluate(
          (element) => (element as HTMLImageElement).naturalWidth
        )
      )
      .toBeGreaterThan(0);
    await screenshot(fixture, page, "real-raw-preview.png");
    await page.keyboard.press("Escape");
    await page.getByTestId("shooting-copy-kept").click();
    await choosePath(fixture, output);
    await page.getByTestId("shooting-output-choose").click();
    await page.getByTestId("shooting-output-confirm").click();
    await expect
      .poll(
        () =>
          database<{ status: string }>(
            fixture,
            "SELECT status FROM shooting_project_outputs"
          )[0]?.status,
        { timeout: 60_000 }
      )
      .toBe("completed");
    const [item] = database<{ target_path: string }>(
      fixture,
      "SELECT target_path FROM shooting_project_output_items WHERE kind='original' AND relative_path LIKE '%.DNG'"
    );
    expect(
      createHash("sha256")
        .update(fs.readFileSync(item.target_path))
        .digest("hex")
    ).toBe(expectedHash);
    expectNoProjectImports(fixture);
  } finally {
    await close(fixture);
  }
});

test("keeps compact mixed task cards stable across task counts, searches and window sizes", async () => {
  test.setTimeout(180_000);
  const fixture = await createFixture("cull-card-grid");
  try {
    const page = await launch(fixture);
    await navigateToCull(page);
    const inserts: string[] = [];
    for (let index = 1; index <= 10; index++) {
      const name = `Unified task ${String(index).padStart(2, "0")}`;
      if (index % 2) {
        inserts.push(
          `INSERT INTO cull_sessions(name,mode,created_at,archived_at) VALUES('${name}','curate',${index},1);`
        );
      } else {
        inserts.push(
          `INSERT INTO shooting_projects(id,name,source_root,source_status,source_checked_at,created_at,updated_at,last_opened_at,archived_at,scan_status,initial_scan_completed) VALUES('${index.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000','${name}','${fixture.sourceRoot.replaceAll("'", "''")}','online',1,${index},1,1,1,'completed',1);`
        );
      }
    }
    execute(fixture, inserts.join("\n"));
    const cards = page.locator("[data-task-key]");
    for (const requested of [
      ...SIZES.map((size) => ({ ...size, zoom: 1 })),
      { width: 720, height: 480, zoom: 1.25 },
    ]) {
      await resize(fixture, page, requested, requested.zoom);
      let cardWidth = 0;
      for (const count of [0, 1, 2, 3, 4, 7, 10]) {
        execute(
          fixture,
          `UPDATE cull_sessions SET archived_at=CASE WHEN created_at<=${count} THEN NULL ELSE 1 END; UPDATE shooting_projects SET archived_at=CASE WHEN created_at<=${count} THEN NULL ELSE 1 END;`
        );
        await page.evaluate(() =>
          window.dispatchEvent(new Event("cull-archive-changed"))
        );
        await page.evaluate(() => window.__e2eNavigate?.("/"));
        await navigateToCull(page);
        await expect(cards).toHaveCount(count);
        await expectLayoutInsideViewport(page);
        if (count === 0) {
          continue;
        }
        const box = await cards.first().boundingBox();
        expect(box).not.toBeNull();
        if (!box) {
          throw new Error("Missing task card");
        }
        if (count === 1) {
          cardWidth = box.width;
        }
        expect(Math.abs(box.width - cardWidth)).toBeLessThan(2);
        const columns = await page
          .getByTestId("cull-task-grid")
          .evaluate(
            (element) =>
              getComputedStyle(element).gridTemplateColumns.split(" ").length
          );
        const normalColumns = requested.width === 1280 ? 3 : 2;
        expect(columns).toBe(requested.zoom > 1 ? 1 : normalColumns);
        const keys = await cards.evaluateAll((elements) =>
          elements.map((element) => element.getAttribute("data-task-key"))
        );
        expect(new Set(keys).size).toBe(count);
      }
      const sizes = await cards.evaluateAll((elements) =>
        elements.map((element) => element.getBoundingClientRect().height)
      );
      expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThan(2);
      await page.getByRole("searchbox").fill("  UNIFIED TASK 01  ");
      await expect(cards).toHaveCount(1);
      expect(
        Math.abs(((await cards.first().boundingBox())?.width ?? 0) - cardWidth)
      ).toBeLessThan(2);
      await cards
        .first()
        .getByRole("button", { name: "More task actions" })
        .click();
      await expectLayoutInsideViewport(page);
      await page.keyboard.press("Escape");
      await cards
        .first()
        .getByRole("button", { name: "More task actions" })
        .click();
      await page.getByRole("button", { name: "Rename", exact: true }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await expectLayoutInsideViewport(page);
      await page.keyboard.press("Escape");
      await page.getByRole("searchbox").fill("");
      await expect(cards).toHaveCount(10);
    }
    await resize(fixture, page, { width: 1280, height: 800 });
    await test.info().attach("compact-unified-cards-1280x800", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
    expectNoProjectImports(fixture);
  } finally {
    await close(fixture);
  }
});

test("persists natural review completion and returns to the searched archive", async () => {
  const fixture = await createFixture("shooting-natural-completion");
  try {
    const page = await launch(fixture);
    await navigateToCull(page);
    const projectId = await openFolder(fixture, page);
    await waitPrepared(fixture, 1);
    await expect(page.getByTestId("cull-curate-current")).toBeVisible();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByTestId("cull-result-card")).toHaveCount(1);
    await expect
      .poll(
        () =>
          database<{ status: string }>(
            fixture,
            `SELECT status FROM cull_sessions WHERE project_id='${projectId}' AND mode='curate'`
          )[0].status
      )
      .toBe("completed");
    await page.getByTestId(`cull-archive-project-${projectId}`).click();
    await page.getByTestId("cull-archive-list-link").click();
    for (const size of SIZES) {
      await resize(fixture, page, size);
      await expectLayoutInsideViewport(page);
    }
    await page.getByTestId("settings-back").click();
    await expect(page.getByTestId("cull-open-folder")).toBeVisible();
    await page.getByTestId("cull-archive-list-link").click();
    await page.getByRole("searchbox").fill("秋日外拍");
    await page
      .getByTestId("shooting-project-card")
      .getByRole("button", {
        name: `Open culling task: ${path.basename(fixture.sourceRoot)}`,
      })
      .click();
    await page.getByTestId("shooting-project-back").click();
    await expect(page.getByRole("searchbox")).toHaveValue("秋日外拍");
    await expect(page.getByTestId("shooting-project-card")).toHaveCount(1);
    await page.getByTestId("settings-back").click();
    await expect(page.getByTestId("cull-open-folder")).toBeVisible();
    expectNoProjectImports(fixture);
    expect(database(fixture, "SELECT id FROM photos")).toHaveLength(0);
  } finally {
    await close(fixture);
  }
});

test("explains an empty source and discovers added photos on retry", async () => {
  const fixture = await createFixture("shooting-empty-recovery");
  // This is the fixture-owned PNG created above, inside its isolated runtime.
  fs.unlinkSync(fixture.sourceFile);
  try {
    const page = await launch(fixture);
    await navigateToCull(page);
    await openFolder(fixture, page);
    await expect(page.getByTestId("cull-waiting-state")).toContainText(
      "No supported photos found"
    );
    for (const size of SIZES) {
      await resize(fixture, page, size);
      await expectLayoutInsideViewport(page);
    }
    await addPhotos(fixture);
    await page
      .getByRole("button", { name: "Check for new photos", exact: true })
      .click();
    await expect(page.getByTestId("cull-curate-current")).toBeVisible();
    await waitPrepared(fixture, 3);
    expectNoProjectImports(fixture);
  } finally {
    await close(fixture);
  }
});

test("explains completed offline previews and disables redundant preparation across window sizes", async () => {
  const fixture = await createFixture("shooting-preview-feedback");
  try {
    const page = await launch(fixture);
    await navigateToCull(page);
    await openFolder(fixture, page);
    await waitPrepared(fixture, 1);
    await page.getByTestId("shooting-source-details").click();
    for (const size of SIZES) {
      await resize(fixture, page, size);
      const button = page.getByTestId("shooting-prepare-previews");
      await expect(button).toHaveText("Offline previews ready");
      await expect(button).toBeDisabled();
      await expect(page.getByTestId("shooting-preview-help")).toContainText(
        "copying originals still requires the source"
      );
      await expectLayoutInsideViewport(page);
      await button.scrollIntoViewIfNeeded();
      await expect(button).toBeInViewport({ ratio: 1 });
    }
    await resize(fixture, page, SIZES[0], 1.25);
    await expectLayoutInsideViewport(page);
    await screenshot(fixture, page, "offline-preview-ready-125.png");
    expectNoProjectImports(fixture);
  } finally {
    await close(fixture);
  }
});

test("keeps archives compact with the shared glass toolbar and clears all confirmed archives while preserving photos", async () => {
  const fixture = await createFixture("shooting-archive-clear-layout");
  const sourceBytes = fs.readFileSync(fixture.sourceFile);
  const copied = path.join(fixture.root, "delivered-original.png");
  fs.copyFileSync(fixture.sourceFile, copied);
  try {
    const page = await launch(fixture);
    await navigateToCull(page);
    const projectId = await openFolder(fixture, page);
    await waitPrepared(fixture, 1);
    await page.getByTestId(`cull-archive-project-${projectId}`).click();
    const rows = Array.from(
      { length: 24 },
      (_, index) =>
        `INSERT INTO cull_sessions(name,mode,created_at,archived_at) VALUES('Library archive ${index}','curate',${index + 1},10);`
    );
    execute(
      fixture,
      rows.join("\n") +
        `\nINSERT INTO cull_sessions(name,mode,created_at) VALUES('Active library stays','curate',1);\nINSERT INTO photos(path,filename,created_at) VALUES('${fixture.sourceFile.replaceAll("'", "''")}','original.png',1);`
    );
    await page.getByTestId("cull-archive-list-link").click();
    await expect(page.locator("[data-task-key]")).toHaveCount(25);
    const header = page.getByTestId("cull-list-header");
    const scroll = page.getByTestId("cull-list-scroll");
    for (const size of SIZES) {
      await resize(fixture, page, size);
      await scroll.evaluate((element) => {
        element.scrollTop = 0;
      });
      await expect
        .poll(() =>
          header.evaluate((element) =>
            element.classList.contains("is-scrolled")
          )
        )
        .toBe(false);
      const bounds = await header.boundingBox();
      expect(bounds?.height).toBeLessThanOrEqual(104);
      await scroll.evaluate((element) => {
        element.scrollTop = 400;
      });
      await expect
        .poll(() =>
          header.evaluate((element) =>
            element.classList.contains("is-scrolled")
          )
        )
        .toBe(true);
      await expect
        .poll(() =>
          header.evaluate((element) => getComputedStyle(element).backdropFilter)
        )
        .toContain("blur");
      expect(
        Math.abs(
          ((await header.boundingBox())?.y ?? -1000) - (bounds?.y ?? 1000)
        )
      ).toBeLessThan(2);
      await expectLayoutInsideViewport(page);
      await expect(page.getByTestId("cull-clear-archives")).toBeInViewport({
        ratio: 1,
      });
      if (size.width === 720 || size.width === 1280) {
        await screenshot(
          fixture,
          page,
          `archive-glass-${size.width}x${size.height}.png`
        );
      }
    }
    await resize(fixture, page, SIZES[0], 1.25);
    await expectLayoutInsideViewport(page);
    await page.getByRole("searchbox").fill("Library archive 23");
    await expect(page.locator("[data-task-key]")).toHaveCount(1);
    await page.getByTestId("cull-clear-archives").click();
    await expect(page.getByRole("dialog")).toContainText(
      "Clear all 25 archived tasks?"
    );
    await expectLayoutInsideViewport(page);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(
      database(
        fixture,
        "SELECT id FROM cull_sessions WHERE archived_at IS NOT NULL AND project_id IS NULL"
      )
    ).toHaveLength(24);
    await page.getByTestId("cull-clear-archives").click();
    await screenshot(fixture, page, "clear-archives-confirm-125.png");
    await page.getByTestId("cull-clear-archives-confirm").click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.getByRole("searchbox").fill("");
    await expect(
      page.getByText("No archived culling tasks", { exact: true })
    ).toBeVisible();
    expect(database(fixture, "SELECT id FROM shooting_projects")).toHaveLength(
      0
    );
    expect(
      database<{ name: string }>(fixture, "SELECT name FROM cull_sessions")
    ).toEqual([{ name: "Active library stays" }]);
    expect(database(fixture, "SELECT id FROM photos")).toHaveLength(1);
    expect(fs.readFileSync(fixture.sourceFile)).toEqual(sourceBytes);
    expect(fs.readFileSync(copied)).toEqual(sourceBytes);
    expect(
      fs.existsSync(
        path.join(fixture.profile, "data", "shooting-projects", projectId)
      )
    ).toBe(false);
    expectNoProjectImports(fixture);
  } finally {
    await close(fixture);
  }
});

test("drops a folder into direct culling and imports completed output with a visible folder and thumbnails", async () => {
  const fixture = await createFixture("shooting-drop-library");
  const output = path.join(fixture.root, "交付目录");
  fs.mkdirSync(output);
  try {
    const page = await launch(fixture);
    await navigateToCull(page);
    const cdp = await page.context().newCDPSession(page);
    const data = {
      items: [],
      files: [fixture.sourceRoot],
      dragOperationsMask: 1,
    };
    for (const size of SIZES) {
      await resize(fixture, page, size);
      const surface = page.getByRole("region", {
        name: "Photo Culling",
        exact: true,
      });
      const bounds = await surface.boundingBox();
      expect(bounds).not.toBeNull();
      const x = (bounds?.x ?? 0) + 40;
      const y = (bounds?.y ?? 0) + 80;
      await cdp.send("Input.dispatchDragEvent", {
        type: "dragEnter",
        x,
        y,
        data,
      });
      await expect(
        page.getByRole("button", {
          name: "Drop a folder to start culling without importing",
        })
      ).toBeVisible();
      await expectLayoutInsideViewport(page);
      await screenshot(
        fixture,
        page,
        `folder-drop-${size.width}x${size.height}.png`
      );
      await cdp.send("Input.dispatchDragEvent", {
        type: "dragOver",
        x,
        y,
        data,
      });
      await cdp.send("Input.dispatchDragEvent", {
        type: "dragCancel",
        x,
        y,
        data,
      });
    }
    const bounds = await page
      .getByRole("region", { name: "Photo Culling", exact: true })
      .boundingBox();
    const x = (bounds?.x ?? 0) + 40;
    const y = (bounds?.y ?? 0) + 80;
    await cdp.send("Input.dispatchDragEvent", {
      type: "dragEnter",
      x,
      y,
      data,
    });
    await cdp.send("Input.dispatchDragEvent", { type: "dragOver", x, y, data });
    await cdp.send("Input.dispatchDragEvent", { type: "drop", x, y, data });
    await expect(page.getByTestId("shooting-project-name")).toHaveValue(
      path.basename(fixture.sourceRoot)
    );
    await page.getByTestId("shooting-project-create-submit").click();
    await waitPrepared(fixture, 1);
    await expect(page.getByTestId("cull-curate-current")).toBeVisible();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByTestId("cull-result-card")).toHaveCount(1);
    expectNoProjectImports(fixture);
    await page.getByTestId("shooting-copy-kept").click();
    await choosePath(fixture, output);
    await page.getByTestId("shooting-output-choose").click();
    await page.getByTestId("shooting-output-confirm").click();
    await expect
      .poll(
        () =>
          database<{ status: string }>(
            fixture,
            "SELECT status FROM shooting_project_outputs"
          )[0]?.status
      )
      .toBe("completed");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await page.getByTestId("shooting-output-summary").click();
    await expect(page.getByTestId("shooting-output-task")).toContainText(
      "All files verified"
    );
    await page.getByTestId("shooting-add-library").click();
    await page.getByTestId("shooting-library-confirm").click();
    await expect(
      page.getByTestId("shooting-library-dialog").getByRole("status")
    ).toHaveText("Added 1 photos; 0 failed");
    const [imported] = database<{
      id: number;
      path: string;
      folder_id: number;
      folder_path: string;
      explicit_only: number;
    }>(
      fixture,
      "SELECT p.id,p.path,p.folder_id,f.path as folder_path,f.explicit_only FROM photos p JOIN folders f ON p.folder_id=f.id"
    );
    expect(imported.folder_path).toBe(path.dirname(imported.path));
    expect(imported.explicit_only).toBe(1);
    expect(imported.path.startsWith(output + path.sep)).toBe(true);
    await page.evaluate(() => window.__e2eNavigate?.("/"));
    if (
      await page
        .getByRole("button", { name: "Expand sidebar", exact: true })
        .count()
    ) {
      await page
        .getByRole("button", { name: "Expand sidebar", exact: true })
        .click();
    }
    await expect(
      page.getByText(path.basename(fixture.sourceRoot), { exact: true })
    ).toBeVisible();
    const thumbnail = page
      .locator(`img[src*="/photo-thumbnail?id=${imported.id}&"]`)
      .first();
    await expect
      .poll(() =>
        thumbnail.evaluate((img) => (img as HTMLImageElement).naturalWidth)
      )
      .toBeGreaterThan(0);
    await expectLayoutInsideViewport(page);
    await screenshot(fixture, page, "imported-output-gallery.png");
    // Reproduce the older explicit-import bug before reopening the application.
    execute(fixture, "UPDATE photos SET folder_id=NULL; DELETE FROM folders;");
    await close(fixture);
    const reopened = await launch(fixture);
    await expect
      .poll(() =>
        reopened
          .locator(`img[src*="/photo-thumbnail?id=${imported.id}&"]`)
          .first()
          .evaluate((img) => (img as HTMLImageElement).naturalWidth)
      )
      .toBeGreaterThan(0);
    expect(database(fixture, "SELECT id FROM photos")).toHaveLength(1);
    expect(
      database(
        fixture,
        "SELECT p.id FROM photos p JOIN folders f ON f.id=p.folder_id WHERE f.photo_count=1 AND f.explicit_only=1"
      )
    ).toHaveLength(1);
  } finally {
    await close(fixture);
  }
});
