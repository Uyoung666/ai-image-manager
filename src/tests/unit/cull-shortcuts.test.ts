import { afterEach, describe, expect, it } from "vitest";
import { cullShortcutBlocked } from "@/utils/cull-shortcuts";

afterEach(() => {
  document.body.replaceChildren();
});
describe("shared cull shortcut scope", () => {
  it("ignores a preserved hidden sidebar and blocks a visible project dialog", () => {
    document.body.innerHTML =
      '<div style="display:none"><div role="dialog">sidebar</div></div>';
    expect(
      cullShortcutBlocked(new KeyboardEvent("keydown", { key: "ArrowRight" }))
    ).toBe(false);
    const modal = document.createElement("div");
    modal.setAttribute("role", "dialog");
    document.body.append(modal);
    expect(
      cullShortcutBlocked(new KeyboardEvent("keydown", { key: "ArrowRight" }))
    ).toBe(true);
    modal.setAttribute("data-state", "closed");
    expect(
      cullShortcutBlocked(new KeyboardEvent("keydown", { key: "ArrowRight" }))
    ).toBe(false);
  });
  it("blocks editing inputs without needing a visible dialog", () => {
    const input = document.createElement("input");
    document.body.append(input);
    let blocked = false;
    input.addEventListener("keydown", (event) => {
      blocked = cullShortcutBlocked(event);
    });
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    expect(blocked).toBe(true);
  });
});
