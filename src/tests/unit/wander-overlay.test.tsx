import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordWanderExposure } from "@/actions/wander";
import { WanderOverlay } from "@/components/wander/WanderOverlay";
import type { WanderSession } from "@/types/wander";
import { preloadImageAsync } from "@/utils/local-media-url";

vi.mock("@/actions/wander", () => ({
  recordWanderExposure: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("@/utils/local-media-url", () => ({
  preloadImageAsync: vi.fn().mockResolvedValue(true),
  preloadImage: vi.fn(),
  toLocalMediaUrl: (path: string) => `local-media://${path}`,
}));

const session: WanderSession = {
  mode: "rediscovery",
  photos: [
    {
      fileDate: 1,
      filename: "first.jpg",
      height: 600,
      id: 1,
      isFavorite: false,
      isIndexed: true,
      path: "C:/first.jpg",
      thumbnailPath: "C:/first-thumb.jpg",
      width: 800,
    },
    {
      fileDate: 2,
      filename: "second.jpg",
      height: 600,
      id: 2,
      isFavorite: false,
      isIndexed: true,
      path: "C:/second.jpg",
      thumbnailPath: "C:/second-thumb.jpg",
      width: 800,
    },
  ],
  subtitleKey: "wander.subtitle.rediscovery",
  titleKey: "wander.title.rediscovery",
};

const sessionWithThreePhotos: WanderSession = {
  ...session,
  photos: [
    ...session.photos,
    {
      fileDate: 3,
      filename: "third.jpg",
      height: 600,
      id: 3,
      isFavorite: false,
      isIndexed: true,
      path: "C:/third.jpg",
      thumbnailPath: "C:/third-thumb.jpg",
      width: 800,
    },
  ],
};

const hamsterWheelSession: WanderSession = {
  mode: "hamsterWheel",
  photos: [],
  subtitleKey: "wander.subtitle.hamsterWheel",
  titleKey: "wander.title.hamsterWheel",
};

function renderOverlay(
  overrides: Partial<Parameters<typeof WanderOverlay>[0]> = {}
) {
  return render(
    <WanderOverlay
      intervalMs={3000}
      onClose={vi.fn()}
      onRoundComplete={vi.fn()}
      onSave={vi.fn()}
      roundNumber={1}
      saving={false}
      session={session}
      {...overrides}
    />
  );
}

async function advanceTimers(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function currentLayer() {
  return screen
    .getByRole("dialog")
    .querySelector('[data-wander-layer="current"]') as HTMLElement;
}

function pendingPreview() {
  return screen
    .getByRole("dialog")
    .querySelector(
      '[data-wander-layer="pending"] [data-wander-preview]'
    ) as HTMLElement | null;
}

async function revealPendingPhoto() {
  const preview = pendingPreview();
  expect(preview).not.toBeNull();
  fireEvent.load(preview as HTMLElement);
  await advanceTimers(0);
}

function expectCurrentPhoto(filename: string) {
  expect(currentLayer().querySelector(`img[alt="${filename}"]`)).not.toBeNull();
}

function expectPendingPhoto(photoId: number) {
  expect(
    screen.getByRole("dialog").querySelector('[data-wander-layer="pending"]')
  ).toHaveAttribute("data-wander-photo-id", String(photoId));
}

describe("WanderOverlay", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(recordWanderExposure).mockClear();
    vi.mocked(preloadImageAsync).mockReset();
    vi.mocked(preloadImageAsync).mockResolvedValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the theme card for 1.2 seconds before the first photo", () => {
    renderOverlay();

    // The intro card renders the round label; the contain image is not yet.
    expect(screen.getAllByText("wander.roundLabel").length).toBeGreaterThan(0);
    expect(screen.queryByAltText("first.jpg")).not.toBeInTheDocument();

    act(() => vi.advanceTimersByTime(1199));
    expect(screen.queryByAltText("first.jpg")).not.toBeInTheDocument();

    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByAltText("first.jpg")).toBeInTheDocument();
  });

  it("renders the hamster wheel as a persistent screen saver", async () => {
    const onRoundComplete = vi.fn();
    renderOverlay({ onRoundComplete, session: hamsterWheelSession });

    await advanceTimers(1200);

    expect(
      screen.getByRole("img", { name: "wander.title.hamsterWheel" })
    ).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "wander.saveRound" })
    ).not.toBeInTheDocument();

    await advanceTimers(10_000);
    expect(onRoundComplete).not.toHaveBeenCalled();
  });

  it("advances to the next photo after the photo interval", async () => {
    renderOverlay();

    await advanceTimers(1200);
    expectCurrentPhoto("first.jpg");

    await advanceTimers(3000);
    expectCurrentPhoto("first.jpg");
    await revealPendingPhoto();
    expectCurrentPhoto("second.jpg");
  });

  it("switches only after the next preview is ready without an inter-photo fade", async () => {
    renderOverlay({ session: sessionWithThreePhotos });

    await advanceTimers(1200);
    await advanceTimers(3000);
    expectCurrentPhoto("first.jpg");
    expectPendingPhoto(2);

    await revealPendingPhoto();
    expectCurrentPhoto("second.jpg");
    expect(
      screen.getByRole("dialog").querySelector('[data-wander-layer="previous"]')
    ).not.toBeInTheDocument();

    await advanceTimers(2999);
    expectCurrentPhoto("second.jpg");
    await advanceTimers(1);
    await advanceTimers(0);
    expectCurrentPhoto("second.jpg");
    expectPendingPhoto(3);
  });

  it("fires onRoundComplete after the final frame", async () => {
    const onRoundComplete = vi.fn();
    renderOverlay({ onRoundComplete });

    // Advance in steps so each view's effect timer is registered before firing.
    await advanceTimers(1200);
    await advanceTimers(3000);
    await revealPendingPhoto();
    await advanceTimers(3000);
    expect(onRoundComplete).toHaveBeenCalledTimes(1);
  });

  it("records an exposure only after the photo remains visible for two seconds", () => {
    renderOverlay();

    act(() => vi.advanceTimersByTime(1999));
    expect(recordWanderExposure).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(recordWanderExposure).toHaveBeenCalledWith({
      photoId: 1,
      source: "wander",
    });
  });

  it("preloads the current and next two preview and original paths", () => {
    renderOverlay({ session: sessionWithThreePhotos });

    expect(preloadImageAsync).toHaveBeenCalledWith("C:/first-thumb.jpg", 4);
    expect(preloadImageAsync).toHaveBeenCalledWith("C:/first.jpg", 4);
    expect(preloadImageAsync).toHaveBeenCalledWith("C:/second-thumb.jpg", 4);
    expect(preloadImageAsync).toHaveBeenCalledWith("C:/second.jpg", 4);
    expect(preloadImageAsync).toHaveBeenCalledWith("C:/third-thumb.jpg", 4);
    expect(preloadImageAsync).toHaveBeenCalledWith("C:/third.jpg", 4);
  });

  it("keeps the preview visible until the original finishes loading", async () => {
    renderOverlay();

    await advanceTimers(1200);
    const dialog = screen.getByRole("dialog");
    const preview = dialog.querySelector("[data-wander-preview]");
    const full = screen.getByAltText("first.jpg");
    expect(preview).toHaveClass("opacity-100");
    expect(full).toHaveClass("opacity-0");

    fireEvent.load(full);
    expect(preview).toHaveClass("opacity-100");
    expect(full).toHaveClass("opacity-100");
  });

  it("holds the current photo while the next preview is still loading", async () => {
    let resolveNextPreview: ((ready: boolean) => void) | undefined;
    vi.mocked(preloadImageAsync).mockImplementation((filePath) => {
      if (filePath === "C:/second-thumb.jpg") {
        return new Promise<boolean>((resolve) => {
          resolveNextPreview = resolve;
        });
      }
      return Promise.resolve(true);
    });

    renderOverlay();
    await advanceTimers(1200);
    await advanceTimers(3000);
    expectCurrentPhoto("first.jpg");
    expect(resolveNextPreview).toBeTypeOf("function");

    await act(async () => {
      resolveNextPreview?.(true);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    await advanceTimers(0);
    expectCurrentPhoto("first.jpg");
    await revealPendingPhoto();
    expectCurrentPhoto("second.jpg");
  });

  it("keeps the preview when the original image fails", () => {
    const onRoundComplete = vi.fn();
    renderOverlay({ onRoundComplete });

    act(() => vi.advanceTimersByTime(1200));
    const dialog = screen.getByRole("dialog");
    const preview = dialog.querySelector("[data-wander-preview]");
    const full = screen.getByAltText("first.jpg");
    expect(preview).not.toBeNull();

    fireEvent.error(full);

    expect(preview).toHaveClass("opacity-100");
    expect(onRoundComplete).not.toHaveBeenCalled();
  });

  it("skips a photo whose preview fails", async () => {
    const onRoundComplete = vi.fn();
    renderOverlay({ onRoundComplete });

    await advanceTimers(1200);
    const dialog = screen.getByRole("dialog");
    const preview = dialog.querySelector("[data-wander-preview]");
    expect(preview).not.toBeNull();

    fireEvent.error(preview as HTMLElement);
    await advanceTimers(0);
    expectCurrentPhoto("first.jpg");
    await revealPendingPhoto();
    expectCurrentPhoto("second.jpg");

    fireEvent.error(
      screen
        .getByRole("dialog")
        .querySelector(
          '[data-wander-layer="current"] [data-wander-preview]'
        ) as HTMLElement
    );
    await advanceTimers(0);
    expect(onRoundComplete).toHaveBeenCalledTimes(1);
  });

  it("saves the current round when the save button is clicked", () => {
    const onSave = vi.fn();
    renderOverlay({ onSave });

    act(() => vi.advanceTimersByTime(1200));
    fireEvent.click(screen.getByRole("button", { name: "wander.saveRound" }));
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("only closes on Escape and keeps other keyboard input inside the overlay", () => {
    const onClose = vi.fn();
    renderOverlay({ onClose });

    const regularKey = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "ArrowRight",
    });
    fireEvent(window, regularKey);
    expect(onClose).not.toHaveBeenCalled();
    expect(regularKey.defaultPrevented).toBe(true);

    const escapeKey = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Escape",
    });
    fireEvent(window, escapeKey);
    expect(onClose).toHaveBeenCalledOnce();
    expect(escapeKey.defaultPrevented).toBe(true);
  });

  it("does not close when the image or wheel is used", () => {
    const onClose = vi.fn();
    renderOverlay({ onClose });

    act(() => vi.advanceTimersByTime(1200));
    fireEvent.pointerDown(screen.getByAltText("first.jpg"));
    fireEvent.wheel(screen.getByRole("dialog"));

    expect(onClose).not.toHaveBeenCalled();
  });

  it("pauses and resumes playback with Space", async () => {
    renderOverlay();

    await advanceTimers(1200);
    fireEvent.keyDown(window, { code: "Space", key: " " });
    await advanceTimers(3000);
    expectCurrentPhoto("first.jpg");
    expect(screen.getByRole("status")).toHaveTextContent("wander.paused");

    await act(async () => {
      fireEvent.keyDown(window, { code: "Space", key: " " });
      await Promise.resolve();
      await Promise.resolve();
    });
    await advanceTimers(2999);
    expectCurrentPhoto("first.jpg");
    await advanceTimers(3001);
    await revealPendingPhoto();
    await advanceTimers(0);
    expectCurrentPhoto("second.jpg");
  });

  it("keeps controls visible while hovered and hides them after leaving", () => {
    renderOverlay();

    act(() => vi.advanceTimersByTime(1200));
    const dialog = screen.getByRole("dialog");
    const header = dialog.querySelector("header");
    expect(header).not.toBeNull();

    fireEvent.mouseMove(header as HTMLElement);
    act(() => vi.advanceTimersByTime(5000));
    expect(header).toHaveClass("opacity-100");

    fireEvent.mouseMove(dialog);
    act(() => vi.advanceTimersByTime(3499));
    expect(header).toHaveClass("opacity-100");
    act(() => vi.advanceTimersByTime(1));
    expect(header).toHaveClass("opacity-0");
  });

  it("renders a persistent round progress line", async () => {
    renderOverlay();

    await advanceTimers(1200);
    const progress = screen.getByRole("progressbar");
    expect(progress).toHaveAttribute("aria-valuenow", "1");
    expect(progress.firstElementChild).toHaveStyle({ width: "50%" });

    await advanceTimers(3000);
    await revealPendingPhoto();
    expect(progress).toHaveAttribute("aria-valuenow", "2");
    expect(progress.firstElementChild).toHaveStyle({ width: "100%" });
  });

  it("never renders the old completion page", async () => {
    renderOverlay();

    await advanceTimers(1200);
    await advanceTimers(3000);
    await revealPendingPhoto();
    await advanceTimers(3000);
    await advanceTimers(1000);
    expect(screen.queryByText("wander.again")).not.toBeInTheDocument();
    expect(screen.queryByText("wander.saveAlbum")).not.toBeInTheDocument();
  });
});
