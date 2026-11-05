import { afterEach, describe, expect, it, vi } from "vitest";
import { AsciiRenderer } from "@/plugins/builtins/ascii-ocean/renderer";

afterEach(() => vi.restoreAllMocks());

describe("ASCII Ocean renderer palette", () => {
  it("shares CSS background tokens and reads styles only on initialization or mode changes", () => {
    const context = {
      fillStyle: "",
      fillRect: vi.fn(),
      setTransform: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
    };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      context as unknown as CanvasRenderingContext2D
    );
    const style = document.createElement("div").style;
    const computed = vi
      .spyOn(window, "getComputedStyle")
      .mockReturnValue(style);
    const renderer = new AsciiRenderer(document.createElement("canvas"));
    // The provider may activate after the child backdrop's initial effect.
    renderer.setDark(true);
    style.setProperty("--background", "#123456");
    style.setProperty("--ocean-shark-glyph", "#abcdef");
    renderer.setDark(true);
    expect(context.fillStyle).toBe("#123456");
    const reads = computed.mock.calls.length;
    renderer.setDark(true);
    renderer.resize(320, 240, 1);
    expect(computed).toHaveBeenCalledTimes(reads);
    expect(context.fillStyle).toBe("#123456");
    style.setProperty("--background", "#f6f8fa");
    renderer.setDark(false);
    expect(context.fillStyle).toBe("#f6f8fa");
    expect(computed).toHaveBeenCalledTimes(reads + 1);
    renderer.dispose();
  });
});
