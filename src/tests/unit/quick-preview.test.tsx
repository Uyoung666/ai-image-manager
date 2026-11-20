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

function previewFrame(tier = "clear") {
  const frame = document.querySelector<HTMLImageElement>(
    `[data-browse-frame="${tier}"]`
  );
  if (!frame) {
    throw new Error(`Missing preview frame ${tier}`);
  }
  return frame;
}

async function loadPreview(image: HTMLImageElement) {
  await act(async () => fireEvent.load(image));
}

describe("QuickPreview", () => {
  it("replaces the same photo's request and load state after its cached version changes", async () => {
    const props = { onClose: vi.fn(), onNavigate: vi.fn() };
    const first = {
      ...photo,
      thumbnailPath: "C:/Thumbs/old.webp",
      thumbnailVersion: "pending-descriptor",
    };
    const { rerender } = render(<QuickPreview {...props} photo={first} />);
    const previous = previewFrame();
    const oldSource = previous.getAttribute("src");
    await loadPreview(previous);
    expect(previous).toHaveClass("opacity-100");
    rerender(
      <QuickPreview
        {...props}
        photo={{ ...first, thumbnailPath: "C:/Thumbs/new.webp" }}
      />
    );
    const current = previewFrame();
    expect(current).not.toBe(previous);
    expect(current.getAttribute("src")).not.toBe(oldSource);
    expect(decodeURIComponent(current.getAttribute("src") ?? "")).toContain(
      "new.webp"
    );
    expect(current).toHaveClass("opacity-0");
    fireEvent.error(previous);
    expect(screen.queryByRole("button", { name: "retry" })).toBeNull();
    await loadPreview(current);
    expect(current).toHaveClass("opacity-100");
  });

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

    const image = previewFrame();
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

  it("does not carry load errors or late image events into the next photo", async () => {
    const props = { onClose: vi.fn(), onNavigate: vi.fn() };
    const { rerender } = render(<QuickPreview {...props} photo={photo} />);
    const oldImage = previewFrame();
    fireEvent.error(oldImage);
    const fallback = document.querySelectorAll(
      '[data-browse-frame="clear"]'
    )[1];
    if (fallback) {
      fireEvent.error(fallback);
    }
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
    const nextImage = previewFrame();
    expect(screen.queryByRole("button", { name: "retry" })).toBeNull();
    await loadPreview(nextImage);
    fireEvent.error(oldImage);
    expect(screen.getByRole("img", { name: "good.jpg" })).toHaveClass(
      "opacity-100"
    );
  });

  it("keeps a loaded placeholder if the clear preview fails and can retry the upgrade", async () => {
    render(
      <QuickPreview
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        photo={{
          ...photo,
          path: "C:/Photos/image.heic",
          thumbnailPath: "C:/Thumbs/image.webp",
        }}
      />
    );
    const small = previewFrame("placeholder");
    const clear = previewFrame();
    await loadPreview(small);
    expect(small).toHaveClass("opacity-100");
    fireEvent.error(clear);
    expect(small).toHaveClass("opacity-100");
    fireEvent.click(screen.getByRole("button", { name: "retry" }));
    await loadPreview(previewFrame());
    expect(previewFrame()).toHaveClass("opacity-100");
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

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useLocation: ({
    select,
  }: {
    select: (location: { state: { __TSR_index: number } }) => unknown;
  }) => select({ state: { __TSR_index: 0 } }),
}));

it("does not drag unavailable originals and replaces futile retries with source recovery", () => {
  const startDrag = vi.fn();
  window.electronAPI = {
    ...window.electronAPI,
    startDrag,
  } as typeof window.electronAPI;
  render(
    <QuickPreview
      onClose={vi.fn()}
      onNavigate={vi.fn()}
      photo={{ ...photo, sourceStatus: "offline" }}
    />
  );
  const image = previewFrame();
  expect(image).toHaveAttribute("draggable", "false");
  fireEvent.dragStart(image);
  expect(startDrag).not.toHaveBeenCalled();
  fireEvent.error(image);
  expect(
    screen.queryByRole("button", { name: "retry" })
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "libraryReliability.goToSettings" })
  ).toBeVisible();
});
