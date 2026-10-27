import { type ElectronApplication, expect, type Page } from "@playwright/test";

/** The development splash window may be created before the actual renderer. */
export async function waitForHomeWindow(
  app: ElectronApplication
): Promise<Page> {
  let home: Page | undefined;
  await expect
    .poll(
      async () => {
        for (const page of app.windows()) {
          try {
            if (
              !page.isClosed() &&
              (await page.locator("input.home-search-input").count())
            ) {
              home = page;
              return true;
            }
          } catch {
            // The splash can close while this snapshot is being read.
          }
        }
        return false;
      },
      { timeout: 30_000 }
    )
    .toBe(true);
  if (!home) {
    throw new Error("Home renderer was not created");
  }
  return home;
}
