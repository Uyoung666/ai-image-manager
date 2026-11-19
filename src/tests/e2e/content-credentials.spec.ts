import fs from "node:fs";
import path from "node:path";
import { expect, type Locator } from "@playwright/test";
import { preparePackagedExecutable } from "./helpers/packaged-inspection";
import {
  closeTestApp,
  createTestRuntime,
  launchTestApp,
  test,
} from "./helpers/test-runtime";
import { seedWanderLibrary } from "./helpers/wander";

const SIZES = [
  [720, 480],
  [900, 600],
  [1280, 800],
] as const;
const DETECTED = "Credential clues found, not verified";
const VERIFIED =
  "Credential matches this file, but the signing certificate is not trusted";
const VERIFY_ACTION = /^(Verify this photo|Verify again)$/;

async function expectCredentials(section: Locator, summary: string) {
  await expect(section).toContainText(summary, { timeout: 25_000 });
  const heading = section.getByRole("heading", { name: "Content Credentials" });
  await heading.scrollIntoViewIfNeeded();
  await expectSectionInWindow(section);
}

async function expectSectionInWindow(section: Locator) {
  const boundary = await section.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return {
      left: bounds.left,
      overflow: element.scrollWidth - element.clientWidth,
      right: bounds.right,
      width: window.innerWidth,
    };
  });
  expect(boundary.left).toBeGreaterThanOrEqual(0);
  expect(boundary.right).toBeLessThanOrEqual(boundary.width + 1);
  expect(boundary.overflow).toBeLessThanOrEqual(1);
}

test("shows consistent Content Credentials in the inspector and lightbox at three window sizes", async ({
  browserName: _browserName,
}, testInfo) => {
  test.setTimeout(180_000);
  const root = createTestRuntime("content-credentials");
  const signedSample = process.env.AIM_E2E_C2PA_SAMPLE;
  fs.mkdirSync(testInfo.outputDir, { recursive: true });
  const executable = await preparePackagedExecutable(root, testInfo.outputDir);
  seedWanderLibrary(root, { photoCount: 4 });
  const source = path.join(root, "e2e-photos", "photo-1.jpg");
  if (signedSample) {
    fs.copyFileSync(signedSample, source);
  }
  const launch = () =>
    launchTestApp(root, {
      args: [
        "--disable-gpu-sandbox",
        "--no-sandbox",
        "--e2e",
        `--user-data-dir=${root}`,
        ...(executable ? [] : [path.resolve(".")]),
      ],
      env: {
        ...process.env,
        AI_IMAGE_MANAGER_E2E_USER_DATA_DIR: root,
        APPDATA: path.join(root, "roaming"),
        CI: "e2e",
      },
      executablePath: executable,
      timeout: executable ? 60_000 : 30_000,
    });
  let app = await launch();
  const loadPage = async () => {
    const page = await app.firstWindow();
    await page.addInitScript(() => localStorage.setItem("lang", "en"));
    await page.reload();
    return page;
  };
  const hasVerifier = Boolean(executable && signedSample);
  const detectedSummary = signedSample ? DETECTED : "No credential clues found";
  try {
    let page = await loadPage();
    for (const [width, height] of SIZES) {
      if (hasVerifier && width === 1280) {
        await closeTestApp(app);
        app = await launch();
        page = await loadPage();
      }
      const card = page.locator('[data-photo-id="1"]').first();
      const bounds = await app.evaluate(
        ({ BrowserWindow }, [w, h]) => {
          const window = BrowserWindow.getAllWindows()[0];
          window.setSize(w, h);
          return window.getContentBounds();
        },
        [width, height]
      );
      await expect
        .poll(() =>
          page.evaluate(() => [window.innerWidth, window.innerHeight])
        )
        .toEqual([bounds.width, bounds.height]);

      await card.click();
      const inspector = page.locator('[data-surface="inspector"]').last();
      const detailSection = inspector
        .locator("section")
        .filter({
          has: page.getByRole("heading", {
            name: "Content Credentials",
            exact: true,
          }),
        })
        .last();
      await expectCredentials(
        detailSection,
        hasVerifier && width !== 720 ? VERIFIED : detectedSummary
      );
      if (hasVerifier && width === 720) {
        await detailSection
          .getByRole("button", { name: "Verify this photo" })
          .click();
        await expect(detailSection).toContainText(VERIFIED);
      }
      await inspector
        .getByRole("heading", { level: 3, name: "Photo Detail" })
        .locator("..")
        .getByRole("button")
        .last()
        .click();
      await expect(inspector).toBeHidden();
      await card.dblclick();
      const panel = page.getByRole("complementary", { name: "Photo Detail" });
      if (!(await panel.isVisible())) {
        await page
          .getByRole("button", { name: "Photo Detail", exact: true })
          .last()
          .click();
      }
      const lightboxSection = panel
        .locator("section")
        .filter({
          has: page.getByRole("heading", {
            name: "Content Credentials",
            exact: true,
          }),
        })
        .last();
      await expectCredentials(
        lightboxSection,
        hasVerifier ? VERIFIED : detectedSummary
      );
      if (hasVerifier) {
        await expect(
          lightboxSection.getByRole("button", { name: "Verify again" })
        ).toBeEnabled();
        const details = lightboxSection.getByRole("button", {
          name: "Verification details",
        });
        await expect(details).toHaveAttribute("aria-expanded", "true");
        await expect(
          lightboxSection.getByText("Passed", { exact: true })
        ).toHaveCount(2);
        await expect(
          lightboxSection.getByText("Failed", { exact: true })
        ).toHaveCount(1);
        await expectSectionInWindow(lightboxSection);
        await details.focus();
        await page.keyboard.press("Enter");
        await expect(details).toHaveAttribute("aria-expanded", "false");
        await page.keyboard.press("Enter");
        await expect(details).toHaveAttribute("aria-expanded", "true");
        if (width === 1280) {
          fs.appendFileSync(source, "changed after verification");
          await expect(
            lightboxSection.getByText("Passed", { exact: true })
          ).toHaveCount(0);
          await expect(
            lightboxSection.getByRole("button", {
              name: VERIFY_ACTION,
            })
          ).toBeEnabled();
        }
      }
      await page.keyboard.press("Escape");
      await expect(panel).toBeHidden();
      await page.keyboard.press("Escape");
      await expect(card).toBeVisible();
      await page.keyboard.press("Escape");
      if (signedSample && width === 720) {
        await page.evaluate(() => window.__e2eNavigate?.("/dashboard"));
        await page
          .getByRole("button", { name: "Technique", exact: true })
          .click();
        const detected = page
          .getByRole("region", { name: "Content Credentials" })
          .getByRole("button", { name: new RegExp(DETECTED) });
        await expect(detected.locator("strong")).toHaveText("1", {
          timeout: 25_000,
        });
        await detected.click();
        await expect(card).toBeVisible();
        await expect(page.locator('[data-photo-id="2"]')).toHaveCount(0);
        await expect(
          page.getByRole("button", {
            name: new RegExp(`Content Credentials: ${DETECTED}`),
          })
        ).toBeVisible();
        await page
          .getByRole("button", { name: "EXIF Filters", exact: true })
          .click();
        const value = page.getByRole("combobox", { name: "Credential status" });
        await expect(value).toHaveValue(DETECTED);
        await expect(value).toHaveAttribute("readonly", "");
        await page.keyboard.press("Escape");
        await page.getByRole("button", { name: "Reset", exact: true }).click();
        const otherPhoto = page.locator('[data-photo-id="2"]');
        await otherPhoto.click();
        await expect(
          inspector.getByText("No credential clues found", { exact: true })
        ).toBeVisible();
        await inspector
          .getByRole("heading", { level: 3, name: "Photo Detail" })
          .locator("..")
          .getByRole("button")
          .last()
          .click();
        await expect(inspector).toBeHidden();
      }
    }
  } catch (error) {
    const page = app.windows()[0];
    if (page) {
      await testInfo.attach("page-text", {
        body: await page.locator("body").innerText(),
        contentType: "text/plain",
      });
    }
    throw error;
  } finally {
    await closeTestApp(app);
  }
});
