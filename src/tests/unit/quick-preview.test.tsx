import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { QuickPreview } from "@/components/QuickPreview";

vi.mock("@/ipc/manager", () => ({
  ipc: {
    client: {
      shell: {
        openInExplorer: vi.fn(),
      },
    },
  },
}));

const photo = {
  fileDate: new Date("2024-01-01").getTime(),
  filename: "preview.jpg",
  height: 3000,
  id: 1,
  path: "C:/Photos/preview.jpg",
  width: 4000,
};

describe("QuickPreview", () => {
  it("keeps the image fitted to the viewport and only handles navigation shortcuts", () => {
    const onNavigate = vi.fn();
    const { container } = render(
      <QuickPreview onClose={vi.fn()} onNavigate={onNavigate} photo={photo} />
    );

    const image = screen.getByRole("img", { name: photo.filename });
    expect(image).toHaveClass("max-h-[80vh]", "max-w-[90vw]");
    expect(image).not.toHaveAttribute("style");
    expect(
      screen.queryByRole("button", { name: "rotateLeft" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "rotateRight" })
    ).not.toBeInTheDocument();

    fireEvent.wheel(container.firstElementChild as Element, { deltaY: -100 });
    fireEvent.keyDown(window, { key: "r" });
    expect(image).not.toHaveAttribute("style");

    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(onNavigate).toHaveBeenCalledWith(1);
  });

  it("opens the current photo in the lightbox with Enter", () => {
    const onOpenLightbox = vi.fn();
    render(
      <QuickPreview
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        onOpenLightbox={onOpenLightbox}
        photo={photo}
      />
    );

    fireEvent.keyDown(window, { key: "Enter" });
    expect(onOpenLightbox).toHaveBeenCalledOnce();
  });
});
