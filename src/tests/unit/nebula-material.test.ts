import { afterEach, describe, expect, it } from "vitest";
import { NebulaGlassPlugin } from "@/plugins/builtins/nebula-glass";
import type { BuiltinPluginContext } from "@/plugins/types";

const root = document.documentElement;
const disposers: Array<() => void> = [];

function activate(settings: Record<string, number | string> = {}) {
  const context: BuiltinPluginContext = {
    root,
    getSetting: (id) => settings[id],
    onSettingsChanged: () => () => undefined,
    setRootAttribute: (name, value) => {
      if (value === null) {
        root.removeAttribute(name);
      } else {
        root.setAttribute(name, value);
      }
    },
  };
  const dispose = NebulaGlassPlugin.activate(context);
  if (dispose) {
    disposers.push(dispose);
  }
  return () => disposers.pop()?.();
}

afterEach(() => {
  for (const dispose of disposers.reverse()) {
    dispose();
  }
  disposers.length = 0;
  root.removeAttribute("style");
});

describe("Nebula material lifecycle", () => {
  it("publishes material defaults on the root and removes them on disable", () => {
    const dispose = activate();
    expect(root.style.getPropertyValue("--nebula-glass-blur")).toBe("20px");
    expect(
      Number.parseFloat(root.style.getPropertyValue("--nebula-fill-dark"))
    ).toBeCloseTo(60.94);
    expect(
      Number.parseFloat(root.style.getPropertyValue("--nebula-fill-light"))
    ).toBeCloseTo(73.96);
    expect(root.dataset.nebulaBackdrop).toBe("aurora");
    dispose();
    expect(root.style.getPropertyValue("--nebula-glass-blur")).toBe("");
    expect(root.style.getPropertyValue("--nebula-fill-dark")).toBe("");
    expect(root.dataset.nebulaBackdrop).toBeUndefined();
  });

  it("applies edits and reset through reactivation, restoring earlier inline values", () => {
    root.style.setProperty("--nebula-glass-blur", "9px", "important");
    const initial = activate({ blur: 36, frost: 50, backdrop: "image" });
    expect(root.style.getPropertyValue("--nebula-glass-blur")).toBe("36px");
    expect(root.style.getPropertyValue("--nebula-fill-dark")).toBe("79%");
    expect(root.dataset.nebulaBackdrop).toBe("image");
    initial();
    const reset = activate();
    expect(root.style.getPropertyValue("--nebula-glass-blur")).toBe("20px");
    reset();
    expect(root.style.getPropertyValue("--nebula-glass-blur")).toBe("9px");
    expect(root.style.getPropertyPriority("--nebula-glass-blur")).toBe(
      "important"
    );
  });

  it("bounds invalid material values without publishing invalid CSS", () => {
    activate({ blur: Number.NaN, frost: -5 });
    expect(root.style.getPropertyValue("--nebula-glass-blur")).toBe("20px");
    expect(root.style.getPropertyValue("--nebula-fill-dark")).toBe("58%");
    expect(root.style.getPropertyValue("--nebula-fill-light")).toBe("72%");
  });

  it("allows both themes to reach a solid pane at maximum frost", () => {
    activate({ frost: 100 });
    expect(root.style.getPropertyValue("--nebula-fill-dark")).toBe("100%");
    expect(root.style.getPropertyValue("--nebula-fill-light")).toBe("100%");
  });
});
