import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
  it("focuses the preview surface without outlining the filename and keeps tooltips in its layer", async () => {
    const user = userEvent.setup();
    render(
      <QuickPreview onClose={vi.fn()} onNavigate={vi.fn()} photo={photo} />
    );
    const preview = screen.getByRole("dialog");
    await waitFor(() => expect(preview).toHaveFocus());
    expect(screen.getByText(photo.filename)).not.toHaveFocus();
    await user.hover(screen.getByRole("button", { name: "nextPhoto" }));
    const tooltip = await screen.findByRole("tooltip");
    expect(preview).toContainElement(tooltip);
  });
  it("closes exactly once when Escape arrives before the entry animation", () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    const { unmount } = render(
      <QuickPreview onClose={onClose} onNavigate={vi.fn()} photo={photo} />
    );
    try {
      fireEvent.keyDown(window, { key: "Escape" });
      act(() => vi.advanceTimersByTime(240));
      expect(onClose).toHaveBeenCalledOnce();
    } finally {
      unmount();
      vi.useRealTimers();
    }
  });
  it("keeps the image fitted to the viewport and only handles navigation shortcuts", () => {
    const onNavigate = vi.fn();
    const { container } = render(
      <QuickPreview onClose={vi.fn()} onNavigate={onNavigate} photo={photo} />
    );

    const image = screen.getByRole("img", { name: photo.filename });
    expect(image).toHaveClass("max-h-[72dvh]", "max-w-[90dvw]");
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

  it("does not carry load errors or late image events into the next photo", () => {
    const props = { onClose: vi.fn(), onNavigate: vi.fn() };
    const { rerender } = render(<QuickPreview {...props} photo={photo} />);
    const oldImage = screen.getByRole("img");
    fireEvent.error(oldImage);
    expect(screen.getByRole("button", { name: "retry" })).toBeInTheDocument();
    rerender(
      <QuickPreview
        {...props}
        photo={{
          ...photo,
          id: 2,
          path: "C:/Photos/good.jpg",
          filename: "good.jpg",
        }}
      />
    );
    const nextImage = screen.getByRole("img", { name: "good.jpg" });
    expect(screen.queryByRole("button", { name: "retry" })).toBeNull();
    fireEvent.load(nextImage);
    fireEvent.error(oldImage);
    expect(screen.getByRole("img", { name: "good.jpg" })).toHaveClass(
      "opacity-100"
    );
  });

  it("provides mouse navigation with accurate boundaries and a counter", () => {
    const onNavigate = vi.fn();
    const open = vi.fn();
    render(
      <QuickPreview
        index={0}
        onClose={vi.fn()}
        onNavigate={onNavigate}
        onOpenLightbox={open}
        photo={photo}
        total={2}
      />
    );
    expect(
      screen.getByRole("button", { name: "previousPhoto" })
    ).toBeDisabled();
    expect(screen.getByText("1 / 2")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "nextPhoto" }));
    expect(onNavigate).toHaveBeenCalledWith(1);
    fireEvent.click(screen.getByRole("button", { name: "进入灯箱 (Enter)" }));
    expect(open).toHaveBeenCalledOnce();
  });
});
