import { afterEach, describe, expect, it, vi } from "vitest";
import { startNavigationViewTransition } from "@/utils/view-transition-navigation";

const originalStartViewTransition = document.startViewTransition;

afterEach(() => {
  Object.defineProperty(document, "startViewTransition", {
    configurable: true,
    value: originalStartViewTransition,
  });
  vi.restoreAllMocks();
});

describe("view transition navigation", () => {
  it("preserves the Promise navigation contract", () => {
    const navigationPromise = Promise.resolve();
    const updateCallbackDone = Promise.resolve();
    const navigate = vi.fn(() => navigationPromise);
    let updateResult: unknown;
    const startViewTransition = vi.fn(
      (updateCallback: ViewTransitionUpdateCallback) => {
        updateResult = updateCallback();
        return { updateCallbackDone } as ViewTransition;
      }
    );
    Object.defineProperty(document, "startViewTransition", {
      configurable: true,
      value: startViewTransition,
    });

    const result = startNavigationViewTransition(navigate);

    expect(startViewTransition).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledOnce();
    expect(updateResult).toBe(navigationPromise);
    expect(result).toBe(updateCallbackDone);
    expect(typeof result.catch).toBe("function");
  });
});
