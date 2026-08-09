import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WatermarkControls } from "@/components/settings/WatermarkControls";
import type { WatermarkPreviewSettings } from "@/components/WatermarkPreview";

const DEFAULT_SETTINGS: WatermarkPreviewSettings = {
  anchor: "bottomRight",
  enabled: false,
  fontSize: 24,
  imagePath: "",
  imageScale: 15,
  margin: 5,
  mode: "text",
  opacity: 50,
  text: "",
};

function renderControls(overrides: Partial<WatermarkPreviewSettings> = {}) {
  const onSettingsChange = vi.fn();
  render(
    <WatermarkControls
      focusTextSignal={0}
      imageStatus={overrides.mode === "image" ? "ready" : "empty"}
      onChooseImage={async () => undefined}
      onRetrySave={() => undefined}
      onSettingsChange={onSettingsChange}
      saveState="idle"
      wm={{ ...DEFAULT_SETTINGS, ...overrides }}
    />
  );
  return onSettingsChange;
}

describe("WatermarkControls", () => {
  it("switches between explicit text and image modes", () => {
    const onSettingsChange = renderControls();

    fireEvent.click(screen.getByRole("button", { name: "watermarkImageMode" }));

    expect(onSettingsChange).toHaveBeenCalledWith({ mode: "image" });
  });

  it("keeps image controls and accessible position buttons in image mode", () => {
    renderControls({ imagePath: "C:/logo.png", mode: "image" });

    expect(screen.getByText("watermarkAssetReady")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "anchor_bottomRight" })
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByRole("button", { name: "anchor_topLeft" })
    ).toHaveAttribute("aria-pressed", "false");
  });
});
