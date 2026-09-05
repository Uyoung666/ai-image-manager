import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PreviewContextMenu } from "@/components/PreviewContextMenu";

const { toast } = vi.hoisted(() => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock("sonner", () => ({ toast }));

const menu = {
  open: true,
  photoPath: "C:/photos/preview.jpg",
  x: 10,
  y: 10,
};

describe("PreviewContextMenu", () => {
  afterEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: undefined,
    });
  });

  it("reports path and image copy feedback", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const copyImageToClipboard = vi.fn().mockResolvedValue(true);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: { copyImageToClipboard },
    });
    render(
      <PreviewContextMenu
        menu={menu}
        onClose={vi.fn()}
        onOpenExplorer={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "copyPath" }));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("pathCopied")
    );

    fireEvent.click(screen.getByRole("button", { name: "copyImage" }));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("imageCopiedToClipboard")
    );
  });

  it("reports copy failure when either clipboard operation fails", async () => {
    const writeText = vi
      .fn()
      .mockRejectedValue(new Error("clipboard unavailable"));
    const copyImageToClipboard = vi.fn().mockResolvedValue(false);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: { copyImageToClipboard },
    });
    render(
      <PreviewContextMenu
        menu={menu}
        onClose={vi.fn()}
        onOpenExplorer={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "copyPath" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("copyFailed"));
    fireEvent.click(screen.getByRole("button", { name: "copyImage" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("copyFailed"));
  });
});
