import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import {
  type ElectronApplication,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";
import { launchWanderApp, seedWanderLibrary } from "./helpers/wander";

const require = createRequire(import.meta.url);
const electronPath = require("electron") as string;

const WINDOW_SIZES = [
  { height: 480, width: 720 },
  { height: 600, width: 900 },
  { height: 800, width: 1280 },
] as const;

const ALBUM_NAME = "E2E Filter Album";
const CAMERA_MODEL = "E2E Camera";
const BROWSE_SESSION_STORAGE_KEY = "browse_session_home";
const FILTER_PRESETS_STORAGE_KEY = "exif-filter-presets";
const CLICK_PRESET_NAME = "E2E Click Preset";
const ENTER_PRESET_NAME = "E2E Enter Preset";
const E2E_ALICE_PATTERN = /E2E Alice.*2 photos/;
const NAMED_PEOPLE_PATTERN = /Named/;
const BATCH_RENAME_DIALOG_PATTERN = /Batch Rename/;
const FORMAT_CONVERSION_DIALOG_PATTERN = /Format Conversion/;

let electronApp: ElectronApplication | undefined;
let page: Page | undefined;

const userDataDir = path.join(
  os.tmpdir(),
  `ai-image-manager-e2e-ux-round-two-${process.pid}-${Date.now()}`
);

function requireApp(): ElectronApplication {
  if (!electronApp) {
    throw new Error("Electron application failed to launch");
  }
  return electronApp;
}

function requirePage(): Page {
  if (!page) {
    throw new Error("Electron window was not created");
  }
  return page;
}

/** Add only the rows needed by the UX flows to the existing wander fixture. */
function seedUxRows(): void {
  seedWanderLibrary(userDataDir, { photoCount: 14 });

  const dbPath = path.join(userDataDir, "data", "ai-image-manager.db");
  const script = `
    const Database = require("better-sqlite3");
    const db = new Database(process.env.AIM_UX_ROUND_TWO_DB);
    db.pragma("foreign_keys = ON");
    const now = Date.now();

    db.prepare(
      "UPDATE exif_data SET camera_make = ?, camera_model = ?, lens_model = ?, focal_length = ?, focal_length_num = ?, aperture = ?, shutter_speed = ?, shutter_speed_num = ?, iso = ? WHERE photo_id IN (1, 2)"
    ).run("Sony", "${CAMERA_MODEL}", "E2E Prime 35mm", "35mm", 35, 2.8, "1/125", 0.008, 200);

    const album = db.prepare(
      "INSERT INTO albums (name, description, cover_photo_id, is_smart, smart_rules, created_at) VALUES (?, ?, ?, 0, NULL, ?)"
    ).run("${ALBUM_NAME}", "Round two UX fixture", 1, now);
    const albumId = Number(album.lastInsertRowid);
    const addToAlbum = db.prepare(
      "INSERT INTO album_photos (album_id, photo_id, sort_order) VALUES (?, ?, ?)"
    );
    addToAlbum.run(albumId, 1, 0);
    addToAlbum.run(albumId, 2, 1);

    const insertVector = db.prepare(
      "INSERT INTO face_vectors (photo_id, face_index, bbox_x, bbox_y, bbox_width, bbox_height, confidence, embedding, vector_id, is_rejected, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)"
    );
    const vectorOne = Number(
      insertVector.run(1, 0, 0.22, 0.18, 0.32, 0.36, 0.99, null, "e2e-face-1", now).lastInsertRowid
    );
    const vectorTwo = Number(
      insertVector.run(2, 0, 0.24, 0.2, 0.3, 0.34, 0.98, null, "e2e-face-2", now).lastInsertRowid
    );
    const identity = db.prepare(
      "INSERT INTO face_identities (name, representative_photo_id, representative_vector_id, centroid_embedding, face_count, is_confirmed, is_hidden, created_at) VALUES (?, ?, ?, NULL, ?, 1, 0, ?)"
    ).run("E2E Alice", 1, String(vectorOne), 2, now);
    const identityId = Number(identity.lastInsertRowid);
    const addMember = db.prepare(
      "INSERT INTO face_identity_members (identity_id, face_vector_id) VALUES (?, ?)"
    );
    addMember.run(identityId, vectorOne);
    addMember.run(identityId, vectorTwo);
    db.prepare("UPDATE photos SET is_face_processed = 1 WHERE id IN (1, 2)").run();

    const normalized = JSON.stringify({
      vendor: "Sony",
      standard: {
        exposureProgram: "Manual",
        meteringMode: "Matrix",
        whiteBalance: "Auto",
        flashMode: null,
        colorSpace: null,
      },
      capture: {
        captureMode: "Manual",
        driveMode: "Single",
        focalLength: "35mm",
        aperture: "f/2.8",
        shutterSpeed: "1/125",
        iso: "200",
      },
      autofocus: {
        focusMode: "AF-S",
        focusArea: "Center",
        subjectTarget: "Person",
        eyeDetection: true,
        tracking: false,
      },
      processing: {
        inCameraLook: "Neutral",
        stabilizationMode: "On",
        computationalMode: null,
      },
      workflow: {
        rating: "4",
        software: "E2E fixture",
        artist: null,
        copyright: null,
      },
      provenance: {
        status: "not_detected",
        issuer: null,
      },
    });
    db.prepare(
      "INSERT INTO advanced_exif_data (photo_id, status, parser_version, enriched_at, error_message, vendor, capture_mode, exposure_program, metering_mode, white_balance, focus_mode, focus_area, subject_target, eye_detection, tracking, drive_mode, stabilization_mode, computational_mode, in_camera_look, provenance_status, provenance_issuer, normalized_json, vendor_raw_json) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)"
    ).run(1, "complete", 1, now, "Sony", "Manual", "Manual", "Matrix", "Auto", "AF-S", "Center", "Person", 1, 0, "Single", "On", null, "Neutral", "not_detected", normalized, "{}");
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.close();
  `;

  execFileSync(electronPath, ["--eval", script], {
    env: {
      ...process.env,
      AIM_UX_ROUND_TWO_DB: dbPath,
      ELECTRON_RUN_AS_NODE: "1",
    },
    stdio: "pipe",
    timeout: 120_000,
  });
}

async function resizeWindow(width: number, height: number): Promise<void> {
  const contentBounds = await requireApp().evaluate(
    async ({ BrowserWindow }, requestedSize) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) {
        throw new Error("Main BrowserWindow was not found");
      }
      window.setSize(requestedSize.width, requestedSize.height);
      await new Promise((resolve) => setTimeout(resolve, 100));
      return window.getContentBounds();
    },
    { height, width }
  );

  await expect
    .poll(() =>
      requirePage().evaluate(() => ({
        height: window.innerHeight,
        width: window.innerWidth,
      }))
    )
    .toEqual({ height: contentBounds.height, width: contentBounds.width });
}

async function navigateTo(route: string): Promise<void> {
  const currentPage = requirePage();
  const navigatedPath = await currentPage.evaluate((nextRoute) => {
    if (!window.__e2eNavigate) {
      throw new Error("E2E router bridge is unavailable");
    }
    return window.__e2eNavigate(nextRoute);
  }, route);
  expect(navigatedPath).toBe(route);
  await currentPage.locator("main").first().waitFor({ state: "visible" });
  await currentPage.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  });
  await currentPage.waitForTimeout(250);
}

function photoCard(photoId: number): Locator {
  return requirePage().locator(`[data-photo-id="${photoId}"]`).first();
}

async function waitForPhotoGrid(): Promise<void> {
  await expect(requirePage().locator("[data-photo-id]").first()).toBeVisible({
    timeout: 15_000,
  });
}

async function expectGlobalSearchShortcut(): Promise<void> {
  const currentPage = requirePage();
  const searchInput = currentPage.locator(
    '[data-surface="toolbar-content"] form.home-search-form input.home-search-input[role="combobox"]'
  );
  const probe = "ux ctrl-f";

  await expect(searchInput).toBeVisible();
  await searchInput.fill(probe);
  await currentPage.evaluate(() => {
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement) {
      activeElement.blur();
    }
  });
  await expect(searchInput).not.toBeFocused();
  await currentPage.keyboard.press("Control+f");
  await expect(searchInput).toBeFocused();
  await expect
    .poll(() =>
      searchInput.evaluate((element) => ({
        end: (element as HTMLInputElement).selectionEnd,
        start: (element as HTMLInputElement).selectionStart,
      }))
    )
    .toEqual({ end: probe.length, start: 0 });

  await searchInput.fill("");
  await searchInput.blur();
}

async function clearSelection(): Promise<void> {
  const currentPage = requirePage();
  await currentPage.evaluate(() => {
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement) {
      activeElement.blur();
    }
  });
  await currentPage.keyboard.press("Escape");
  await expect.poll(() => getSelectedPhotoIds()).toEqual([]);
}

async function selectPhoto(photoId: number): Promise<void> {
  const card = photoCard(photoId);
  await card.scrollIntoViewIfNeeded();
  await card.click();
  await expect(card).toHaveAttribute("aria-selected", "true");
}

async function selectTwoPhotos(): Promise<void> {
  await selectPhoto(1);
  const second = photoCard(2);
  await second.scrollIntoViewIfNeeded();
  await second.click({ modifiers: ["Control"] });
  await expect(photoCard(1)).toHaveAttribute("aria-selected", "true");
  await expect(second).toHaveAttribute("aria-selected", "true");
  await expect(
    requirePage().getByText("2 selected", { exact: false }).first()
  ).toBeVisible();
}

async function edgeVisibleCard(): Promise<Locator> {
  const currentPage = requirePage();
  const cardData = await currentPage
    .locator("[data-photo-id]")
    .evaluateAll((elements) =>
      elements
        .map((element) => {
          const rect = element.getBoundingClientRect();
          const style = window.getComputedStyle(element);
          return {
            bottom: rect.bottom,
            id: element.getAttribute("data-photo-id"),
            right: rect.right,
            visible:
              style.display !== "none" &&
              style.visibility !== "hidden" &&
              rect.width > 0 &&
              rect.height > 0 &&
              rect.top >= 0 &&
              rect.left >= 0 &&
              rect.bottom <= window.innerHeight &&
              rect.right <= window.innerWidth,
          };
        })
        .filter(
          (
            item
          ): item is {
            bottom: number;
            id: string;
            right: number;
            visible: true;
          } => item.visible && item.id !== null
        )
        .sort(
          (left, right) =>
            right.right + right.bottom - (left.right + left.bottom)
        )
    );
  const id = cardData[0]?.id;
  if (!id) {
    throw new Error("No visible photo card available for context menu test");
  }
  return currentPage.locator(`[data-photo-id="${id}"]`).first();
}

async function openContextMenuAtCard(card: Locator): Promise<Locator> {
  await expect(card).toBeVisible();
  const box = await card.boundingBox();
  if (!box) {
    throw new Error("Photo card has no layout box");
  }
  await card.click({
    button: "right",
    position: {
      x: box.width / 2,
      y: box.height / 2,
    },
  });
  const menu = requirePage().locator('[data-overlay-kind="context-menu"]');
  await expect(menu).toBeVisible();
  return menu;
}

async function expectInsideViewport(target: Locator): Promise<void> {
  const readBounds = () =>
    target.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return {
        bottom: rect.bottom,
        height: rect.height,
        left: rect.left,
        right: rect.right,
        top: rect.top,
        viewportHeight: window.innerHeight,
        viewportWidth: window.innerWidth,
        width: rect.width,
      };
    });

  await expect
    .poll(
      async () => {
        const bounds = await readBounds();
        return (
          bounds.width > 0 &&
          bounds.height > 0 &&
          bounds.left >= -2 &&
          bounds.top >= -2 &&
          bounds.right <= bounds.viewportWidth + 2 &&
          bounds.bottom <= bounds.viewportHeight + 2
        );
      },
      { message: "Expected target to settle inside the viewport" }
    )
    .toBe(true);

  const bounds = await readBounds();
  expect(bounds.width).toBeGreaterThan(0);
  expect(bounds.height).toBeGreaterThan(0);
  expect(bounds.left).toBeGreaterThanOrEqual(-2);
  expect(bounds.top).toBeGreaterThanOrEqual(-2);
  expect(bounds.right).toBeLessThanOrEqual(bounds.viewportWidth + 2);
  expect(bounds.bottom).toBeLessThanOrEqual(bounds.viewportHeight + 2);
}

function getSelectedPhotoIds(): Promise<string[]> {
  return requirePage()
    .locator('[data-photo-id][aria-selected="true"]')
    .evaluateAll((elements) =>
      elements
        .map((element) => element.getAttribute("data-photo-id"))
        .filter((id): id is string => id !== null)
        .sort()
    );
}

async function expectContextMenuKeyboardAndBounds(
  card: Locator
): Promise<void> {
  const currentPage = requirePage();
  const selectedBefore = await getSelectedPhotoIds();
  const menu = await openContextMenuAtCard(card);
  await expectInsideViewport(menu);

  const items = menu.getByRole("menuitem");
  await expect(items.first()).toBeFocused();
  await currentPage.keyboard.press("End");
  await expect(items.last()).toBeFocused();
  await currentPage.keyboard.press("Home");
  await expect(items.first()).toBeFocused();
  await currentPage.keyboard.press("ArrowDown");
  await expect(items.nth(1)).toBeFocused();
  await currentPage.keyboard.press("ArrowUp");
  await expect(items.first()).toBeFocused();
  await currentPage.keyboard.press("Escape");
  await expect(menu).not.toBeVisible();
  await expect.poll(() => getSelectedPhotoIds()).toEqual(selectedBefore);
}

async function expectAlbumFilterThroughContextMenu(
  card: Locator
): Promise<void> {
  const menu = await openContextMenuAtCard(card);
  await menu
    .getByRole("menuitem", { name: "Add to Album", exact: true })
    .click();

  const dialog = requirePage().getByRole("dialog", {
    name: "Add to Album",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await expectInsideViewport(dialog);
  const filter = dialog.getByRole("textbox", { name: "Filter albums" });
  await expect(filter).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: ALBUM_NAME, exact: true })
  ).toBeVisible();

  await filter.fill("does-not-exist");
  await expect(
    dialog.getByText("No matching albums", { exact: true })
  ).toBeVisible();
  await filter.press("Escape");
  await expect(filter).toHaveValue("");
  await expect(
    dialog.getByRole("button", { name: ALBUM_NAME, exact: true })
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog).not.toBeVisible();
}

async function expectAdvancedMetadataCollapse(): Promise<void> {
  const currentPage = requirePage();
  await clearSelection();
  await waitForPhotoGrid();
  await selectPhoto(1);

  const inspector = currentPage.locator('[data-surface="inspector"]').last();
  await expect(inspector).toBeVisible();
  await expectInsideViewport(inspector);
  const details = inspector
    .locator("details")
    .filter({ hasText: "Advanced photography metadata" });
  await expect(details).toBeVisible();
  const isOpen = () =>
    details.evaluate((element) => (element as HTMLDetailsElement).open);
  await expect.poll(isOpen).toBe(false);
  await details.locator("summary").click();
  await expect.poll(isOpen).toBe(true);
  await details.locator("summary").click();
  await expect.poll(isOpen).toBe(false);
  await inspector
    .getByRole("heading", { name: "Photo Detail", level: 3 })
    .locator("..")
    .getByRole("button")
    .last()
    .click();
  await expect(inspector).not.toBeVisible();

  await selectPhoto(1);
  const reopenedInspector = currentPage
    .locator('[data-surface="inspector"]')
    .last();
  const reopenedDetails = reopenedInspector
    .locator("details")
    .filter({ hasText: "Advanced photography metadata" });
  await expect(reopenedDetails).toBeVisible();
  await expect
    .poll(() =>
      reopenedDetails.evaluate(
        (element) => (element as HTMLDetailsElement).open
      )
    )
    .toBe(false);
  await reopenedInspector
    .getByRole("heading", { name: "Photo Detail", level: 3 })
    .locator("..")
    .getByRole("button")
    .last()
    .click();
  await expect(reopenedInspector).not.toBeVisible();
}

async function expectRenameAndConvertKeepSelection(): Promise<void> {
  const currentPage = requirePage();
  await clearSelection();
  await waitForPhotoGrid();
  await selectTwoPhotos();

  await currentPage.getByRole("button", { name: "More", exact: true }).click();
  await currentPage
    .getByRole("button", { name: "Rename", exact: true })
    .click();
  const renameDialog = currentPage.getByRole("dialog", {
    name: BATCH_RENAME_DIALOG_PATTERN,
  });
  await expect(renameDialog).toBeVisible();
  await currentPage.keyboard.press("Escape");
  await expect(renameDialog).not.toBeVisible();
  await expect(photoCard(1)).toHaveAttribute("aria-selected", "true");
  await expect(photoCard(2)).toHaveAttribute("aria-selected", "true");

  await currentPage.getByRole("button", { name: "More", exact: true }).click();
  await currentPage
    .getByRole("button", { name: "Convert Format", exact: true })
    .click();
  const convertDialog = currentPage.getByRole("dialog", {
    name: FORMAT_CONVERSION_DIALOG_PATTERN,
  });
  await expect(convertDialog).toBeVisible();
  await currentPage.keyboard.press("Escape");
  await expect(convertDialog).not.toBeVisible();
  await expect(photoCard(1)).toHaveAttribute("aria-selected", "true");
  await expect(photoCard(2)).toHaveAttribute("aria-selected", "true");
  await currentPage
    .getByRole("button", { name: "Clear selection", exact: true })
    .click();
}

async function expectPeopleNamedFilterRoundTrip(): Promise<void> {
  const currentPage = requirePage();
  await navigateTo("/people");
  await expect(
    currentPage.getByRole("heading", { name: "People" })
  ).toBeVisible();
  const named = currentPage
    .getByRole("button", { name: NAMED_PEOPLE_PATTERN })
    .first();
  await named.click();
  await expect(named).toHaveAttribute("aria-pressed", "true");

  const person = currentPage.getByRole("button", {
    name: E2E_ALICE_PATTERN,
  });
  await expect(person).toBeVisible();
  await person.click();
  await expect(
    currentPage.getByRole("heading", { name: "E2E Alice" })
  ).toBeVisible();
  await expect(photoCard(1)).toBeVisible();
  await expect(photoCard(2)).toBeVisible();

  const detailPage = currentPage.locator('[data-surface="page"]').first();
  await detailPage
    .locator(":scope > div")
    .first()
    .getByRole("button")
    .first()
    .click();
  await expect(
    currentPage.getByRole("heading", { name: "People" })
  ).toBeVisible();
  await expect(
    currentPage.getByRole("button", { name: NAMED_PEOPLE_PATTERN }).first()
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    currentPage.getByRole("button", { name: E2E_ALICE_PATTERN })
  ).toBeVisible();
}

async function expectExifSearchRoundTrip(): Promise<void> {
  const currentPage = requirePage();
  await navigateTo("/");
  await clearSelection();
  await waitForPhotoGrid();

  await currentPage.getByRole("button", { name: "EXIF Filters" }).click();
  const panel = currentPage.locator('[data-overlay-kind="search-filter"]');
  await expect(panel).toBeVisible();
  const camera = panel.getByRole("combobox", { name: "Camera Model" });
  await camera.fill(CAMERA_MODEL);
  await panel
    .getByRole("button", { name: "Apply Filters", exact: true })
    .click();

  await expect(photoCard(1)).toBeVisible();
  await expect(photoCard(2)).toBeVisible();
  await expect
    .poll(() => currentPage.locator("[data-photo-id]").count())
    .toBe(2);
  await expect(
    currentPage.getByText(CAMERA_MODEL, { exact: true }).first()
  ).toBeVisible();

  await navigateTo("/albums");
  await navigateTo("/");
  await expect(photoCard(1)).toBeVisible({ timeout: 15_000 });
  await expect(photoCard(2)).toBeVisible();
  await expect
    .poll(() => currentPage.locator("[data-photo-id]").count())
    .toBe(2);

  await currentPage.getByRole("button", { name: "EXIF Filters" }).click();
  const restoredPanel = currentPage.locator(
    '[data-overlay-kind="search-filter"]'
  );
  await expect(restoredPanel).toBeVisible();
  await expect(
    restoredPanel.getByRole("combobox", { name: "Camera Model" })
  ).toHaveValue(CAMERA_MODEL);
  await restoredPanel
    .getByRole("button", { name: "Close", exact: true })
    .click();
}

async function expectExifPresetInteractions(
  width: number,
  height: number
): Promise<void> {
  const currentPage = requirePage();

  await currentPage.evaluate(
    ({ browseSessionKey, presetsKey }) => {
      localStorage.removeItem(presetsKey);
      sessionStorage.removeItem(browseSessionKey);
    },
    {
      browseSessionKey: BROWSE_SESSION_STORAGE_KEY,
      presetsKey: FILTER_PRESETS_STORAGE_KEY,
    }
  );
  await currentPage.reload();
  await currentPage.locator("main").first().waitFor({ state: "visible" });
  await resizeWindow(width, height);
  await navigateTo("/");
  await clearSelection();
  await waitForPhotoGrid();

  const photoCountBeforePresets = await currentPage
    .locator("[data-photo-id]")
    .count();
  expect(photoCountBeforePresets).toBeGreaterThan(2);

  await currentPage
    .getByRole("button", { name: "EXIF Filters", exact: true })
    .click();
  let panel = currentPage.locator('[data-overlay-kind="search-filter"]');
  await expect(panel).toBeVisible();
  const camera = panel.getByRole("combobox", { name: "Camera Model" });
  await camera.fill(CAMERA_MODEL);
  await expect(camera).toHaveValue(CAMERA_MODEL);

  await panel.getByRole("button", { name: "Save Preset", exact: true }).click();
  let presetPopover = currentPage.locator(
    '[data-overlay-kind="filter-presets"]'
  );
  await expect(presetPopover).toBeVisible();
  await expectInsideViewport(presetPopover);
  await presetPopover
    .getByPlaceholder("Preset name...")
    .fill(CLICK_PRESET_NAME);
  await presetPopover
    .getByRole("button", { name: "Save", exact: true })
    .click();

  await expect(presetPopover).not.toBeVisible();
  await expect(panel).toBeVisible();
  await expect(camera).toHaveValue(CAMERA_MODEL);
  await expect(
    panel.getByRole("button", { name: "Load presets (1)", exact: true })
  ).toBeVisible();

  await panel.getByRole("button", { name: "Save Preset", exact: true }).click();
  presetPopover = currentPage.locator('[data-overlay-kind="filter-presets"]');
  await expect(presetPopover).toBeVisible();
  await expectInsideViewport(presetPopover);
  const enterPresetInput = presetPopover.getByPlaceholder("Preset name...");
  await enterPresetInput.fill(ENTER_PRESET_NAME);
  await enterPresetInput.press("Enter");

  await expect(presetPopover).not.toBeVisible();
  await expect(panel).toBeVisible();
  await expect(camera).toHaveValue(CAMERA_MODEL);
  await expect(
    panel.getByRole("button", { name: "Load presets (2)", exact: true })
  ).toBeVisible();
  await currentPage.waitForTimeout(400);
  await expect(currentPage.locator(".home-search-result-summary")).toHaveCount(
    0
  );
  await expect
    .poll(() => currentPage.locator("[data-photo-id]").count())
    .toBe(photoCountBeforePresets);

  await panel
    .getByRole("button", { name: "Load presets (2)", exact: true })
    .click();
  presetPopover = currentPage.locator('[data-overlay-kind="filter-presets"]');
  await expect(presetPopover).toBeVisible();
  await expectInsideViewport(presetPopover);
  await expect(
    presetPopover.getByRole("button", {
      name: CLICK_PRESET_NAME,
      exact: true,
    })
  ).toBeVisible();
  await expect(
    presetPopover.getByRole("button", {
      name: ENTER_PRESET_NAME,
      exact: true,
    })
  ).toBeVisible();

  const deletedPresetRow = presetPopover
    .getByRole("button", { name: CLICK_PRESET_NAME, exact: true })
    .locator("..");
  await deletedPresetRow
    .getByRole("button", { name: "Delete", exact: true })
    .click();

  await expect(presetPopover).toBeVisible();
  await expect(
    presetPopover.getByRole("button", {
      name: CLICK_PRESET_NAME,
      exact: true,
    })
  ).toHaveCount(0);
  await expect(
    presetPopover.getByRole("button", {
      name: ENTER_PRESET_NAME,
      exact: true,
    })
  ).toBeVisible();
  await expect(panel).toBeVisible();

  const undoButton = currentPage
    .getByRole("button", {
      name: "Undo",
      exact: true,
    })
    .last();
  await expect(undoButton).toBeVisible();
  await undoButton.click();

  if (!(await panel.isVisible())) {
    await currentPage
      .getByRole("button", { name: "EXIF Filters", exact: true })
      .click();
  }
  panel = currentPage.locator('[data-overlay-kind="search-filter"]');
  await expect(panel).toBeVisible();
  presetPopover = currentPage.locator('[data-overlay-kind="filter-presets"]');
  if (!(await presetPopover.isVisible())) {
    await panel
      .getByRole("button", { name: "Load presets (2)", exact: true })
      .click();
  }
  await expect(presetPopover).toBeVisible();
  await expectInsideViewport(presetPopover);
  await expect(
    presetPopover.getByRole("button", {
      name: CLICK_PRESET_NAME,
      exact: true,
    })
  ).toBeVisible();
  await expect(
    presetPopover.getByRole("button", {
      name: ENTER_PRESET_NAME,
      exact: true,
    })
  ).toBeVisible();

  await panel.getByRole("button", { name: "Close", exact: true }).click();
  await expect(panel).not.toBeVisible();
}

test.describe.configure({ mode: "serial" });
test.setTimeout(120_000);

test.beforeAll(async () => {
  process.env.CI = "e2e";
  seedUxRows();
  electronApp = await launchWanderApp(userDataDir);
  page = await electronApp.firstWindow();
  await page.addInitScript(() => {
    window.localStorage.setItem("lang", "en");
    window.localStorage.removeItem("photo-detail.advanced-metadata");
  });
  await page.reload();
  await page.locator("main").first().waitFor({ state: "visible" });
});

test.afterAll(async () => {
  await electronApp?.close();
  fs.rmSync(userDataDir, { force: true, recursive: true });
});

test("EXIF preset popovers stay usable across the responsive window matrix", async () => {
  for (const { height, width } of WINDOW_SIZES) {
    await test.step(`${width}x${height} EXIF preset save, delete, and undo`, async () => {
      await expectExifPresetInteractions(width, height);
    });
  }
});

test("UX round two interactions stay usable across the responsive window matrix", async () => {
  for (const { height, width } of WINDOW_SIZES) {
    await test.step(`${width}x${height} album filter, detail collapse, and context menu`, async () => {
      await resizeWindow(width, height);
      await navigateTo("/");
      await clearSelection();
      await waitForPhotoGrid();
      await expectGlobalSearchShortcut();

      await expectContextMenuKeyboardAndBounds(await edgeVisibleCard());
      await expectAlbumFilterThroughContextMenu(await edgeVisibleCard());
      await expectAdvancedMetadataCollapse();
    });

    if (width === 1280 && height === 800) {
      await test.step("cancel rename and convert keep the multi-selection", async () => {
        await expectRenameAndConvertKeepSelection();
      });
    }

    if (width === 720 && height === 480) {
      await test.step("named people and pure EXIF search restore their browse state", async () => {
        await expectPeopleNamedFilterRoundTrip();
        await expectExifSearchRoundTrip();
      });
    }
  }
});
