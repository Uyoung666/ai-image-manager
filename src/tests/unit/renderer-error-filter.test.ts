import { describe, expect, it } from "vitest";
import { isBenignRendererErrorMessage } from "@/utils/renderer-error-filter";

describe("renderer error filtering", () => {
  it.each([
    "ResizeObserver loop completed with undelivered notifications.",
    "ResizeObserver loop limit exceeded",
    "  ResizeObserver loop limit exceeded  ",
  ])("recognizes benign ResizeObserver delivery warnings", (message) => {
    expect(isBenignRendererErrorMessage(message)).toBe(true);
  });

  it("keeps actionable renderer errors", () => {
    expect(isBenignRendererErrorMessage("ResizeObserver callback failed")).toBe(
      false
    );
    expect(isBenignRendererErrorMessage("TypeError: failed")).toBe(false);
  });
});
