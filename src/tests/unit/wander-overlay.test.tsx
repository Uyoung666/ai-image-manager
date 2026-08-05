import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordWanderExposure } from "@/actions/wander";
import { WanderOverlay } from "@/components/wander/WanderOverlay";
import type { WanderSession } from "@/types/wander";

vi.mock("@/actions/wander", () => ({
  recordWanderExposure: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("@/utils/local-media-url", () => ({
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

describe("WanderOverlay", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(recordWanderExposure).mockClear();
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

  it("advances to the next photo after the photo interval", () => {
    renderOverlay();

    act(() => vi.advanceTimersByTime(1200));
    expect(screen.getByAltText("first.jpg")).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(3000));
    expect(screen.getByAltText("second.jpg")).toBeInTheDocument();
  });

  it("fires onRoundComplete after the final frame", () => {
    const onRoundComplete = vi.fn();
    renderOverlay({ onRoundComplete });

    // Advance in steps so each view's effect timer is registered before firing.
    act(() => vi.advanceTimersByTime(1200));
    act(() => vi.advanceTimersByTime(3000));
    act(() => vi.advanceTimersByTime(3000));
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

  it("skips a failed image and completes on the final frame", () => {
    const onRoundComplete = vi.fn();
    renderOverlay({ onRoundComplete });

    act(() => vi.advanceTimersByTime(1200));
    fireEvent.error(screen.getByAltText("first.jpg"));
    expect(screen.getByAltText("second.jpg")).toBeInTheDocument();

    fireEvent.error(screen.getByAltText("second.jpg"));
    expect(onRoundComplete).toHaveBeenCalledTimes(1);
  });

  it("saves the current round when the save button is clicked", () => {
    const onSave = vi.fn();
    renderOverlay({ onSave });

    act(() => vi.advanceTimersByTime(1200));
    fireEvent.click(screen.getByRole("button", { name: "wander.saveRound" }));
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("closes on keyboard input without passing the input through", () => {
    const onClose = vi.fn();
    renderOverlay({ onClose });

    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "ArrowRight",
    });
    fireEvent(window, event);
    expect(onClose).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
  });

  it("never renders the old completion page", () => {
    renderOverlay();

    act(() => vi.advanceTimersByTime(1200));
    act(() => vi.advanceTimersByTime(3000));
    act(() => vi.advanceTimersByTime(3000));
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.queryByText("wander.again")).not.toBeInTheDocument();
    expect(screen.queryByText("wander.saveAlbum")).not.toBeInTheDocument();
  });
});
