import { expect, type Locator, type Page } from "@playwright/test";

export async function expectStablePress(
  page: Page,
  target: Locator,
  position: "left" | "center" | "right",
  release: "click" | "cancel" = "click"
): Promise<void> {
  const readAppearance = () =>
    target.evaluate(async (element) => {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      );
      // A menu's entrance can move its options before any button is pressed.
      const animations: Animation[] = [];
      for (
        let node: Element | null = element;
        node;
        node = node.parentElement
      ) {
        animations.push(
          ...node
            .getAnimations()
            .filter(
              (animation) =>
                animation.effect?.getComputedTiming().iterations !==
                Number.POSITIVE_INFINITY
            )
        );
      }
      await Promise.allSettled(
        animations.map((animation) => animation.finished)
      );
      const { backgroundColor, transitionDuration } = getComputedStyle(element);
      return {
        background: backgroundColor,
        bounds: element.getBoundingClientRect().toJSON() as DOMRect,
        hasTransition: transitionDuration
          .split(",")
          .some((duration) => Number.parseFloat(duration) > 0),
        reducedMotion:
          document.documentElement.dataset.reducedMotion === "true" ||
          matchMedia("(prefers-reduced-motion: reduce)").matches,
      };
    });

  await expect(target).toBeVisible();
  const { bounds } = await readAppearance();
  const offset = { center: bounds.width / 2, left: 2, right: bounds.width - 2 };
  const x = bounds.x + offset[position];
  const y = bounds.y + bounds.height / 2;
  await page.mouse.move(x, y);
  const before = await readAppearance();
  await target.evaluate((element) => {
    const root = document.documentElement;
    const pressId = String(Number(root.dataset.testPressId ?? "0") + 1);
    root.dataset.testPressId = pressId;
    root.dataset.testPressClicks = "0";
    element.addEventListener(
      "click",
      () => {
        if (root.dataset.testPressId === pressId) {
          root.dataset.testPressClicks = String(
            Number(root.dataset.testPressClicks) + 1
          );
        }
      },
      { signal: AbortSignal.timeout(5000) }
    );
  });

  await page.mouse.down();
  try {
    const pressed = await readAppearance();
    for (const key of ["x", "y", "width", "height"] as const) {
      expect(
        Math.abs(before.bounds[key] - pressed.bounds[key]),
        `${key} changed while holding ${target}`
      ).toBeLessThanOrEqual(1);
    }
    const feedback = await target.getAttribute("data-press-feedback");
    if (feedback === "row") {
      expect(pressed.background).not.toBe(before.background);
      expect(pressed.hasTransition).toBe(false);
      expect(before.hasTransition).toBe(!before.reducedMotion);
    } else {
      expect(pressed.background).toBe(before.background);
    }
    if (release === "cancel") {
      await page.mouse.move(x, before.bounds.y - 2);
    }
  } finally {
    await page.mouse.up();
  }
  await expect(page.locator("html")).toHaveAttribute(
    "data-test-press-clicks",
    release === "click" ? "1" : "0"
  );
}
