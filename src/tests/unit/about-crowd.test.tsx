import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AboutCrowd from "@/components/about/about-crowd";
import { UiPreferencesContext } from "@/contexts/ui-preferences-context";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  playing: vi.fn(),
  resize: vi.fn(),
  destroy: vi.fn(),
}));
vi.mock("@/components/about/crowd-scene", () => ({
  createCrowdScene: mocks.create,
}));
vi.mock("@/actions/shell", () => ({ openExternalLink: vi.fn() }));

let loadedImage: { onload: (() => void) | null; onerror: (() => void) | null };
let intersection: (entries: { isIntersecting: boolean }[]) => void;
let resized: () => void;
const disconnectIntersection = vi.fn();
const disconnectResize = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  mocks.create.mockReturnValue({
    setPlaying: mocks.playing,
    resize: mocks.resize,
    destroy: mocks.destroy,
  });
  vi.stubGlobal(
    "Image",
    class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      src = "";
      constructor() {
        loadedImage = this;
      }
    }
  );
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: typeof intersection) {
        intersection = callback;
      }
      observe() {
        /* callback is controlled by the test */
      }
      disconnect = disconnectIntersection;
    }
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: typeof resized) {
        resized = callback;
      }
      observe() {
        /* callback is controlled by the test */
      }
      disconnect = disconnectResize;
    }
  );
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function loadCrowd() {
  await act(async () => {
    await loadedImage.onload?.();
  });
  await waitFor(() => expect(mocks.create).toHaveBeenCalledOnce());
}

describe("about crowd lifecycle", () => {
  it("plays only when visible, and pauses through the switch and document visibility", async () => {
    render(<AboutCrowd />);
    await loadCrowd();
    expect(mocks.playing).toHaveBeenLastCalledWith(false);
    act(() => intersection([{ isIntersecting: true }]));
    expect(mocks.playing).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "aboutCrowdPlay" }));
    expect(mocks.playing).toHaveBeenLastCalledWith(false);
    fireEvent.click(screen.getByRole("checkbox", { name: "aboutCrowdPlay" }));
    expect(mocks.playing).toHaveBeenLastCalledWith(true);
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    fireEvent(document, new Event("visibilitychange"));
    expect(mocks.playing).toHaveBeenLastCalledWith(false);
    act(() => resized());
    expect(mocks.resize).toHaveBeenCalledOnce();
  });

  it("keeps reduced motion static, then respects the previous switch choice", async () => {
    const value = {
      reduceMotion: true,
      setReduceMotion: async () => undefined,
    };
    const { rerender } = render(
      <UiPreferencesContext.Provider value={value}>
        <AboutCrowd />
      </UiPreferencesContext.Provider>
    );
    await loadCrowd();
    act(() => intersection([{ isIntersecting: true }]));
    expect(screen.getByRole("checkbox")).toBeDisabled();
    expect(mocks.playing).toHaveBeenLastCalledWith(false);
    rerender(
      <UiPreferencesContext.Provider value={{ ...value, reduceMotion: false }}>
        <AboutCrowd />
      </UiPreferencesContext.Provider>
    );
    expect(mocks.playing).toHaveBeenLastCalledWith(true);
    expect(mocks.create).toHaveBeenCalledOnce();
  });

  it("releases the scene and observers on unmount", async () => {
    const { unmount } = render(<AboutCrowd />);
    await loadCrowd();
    unmount();
    expect(mocks.destroy).toHaveBeenCalledOnce();
    expect(disconnectIntersection).toHaveBeenCalledOnce();
    expect(disconnectResize).toHaveBeenCalledOnce();
    expect(loadedImage.onload).toBeNull();
    expect(loadedImage.onerror).toBeNull();
  });

  it("ignores an image callback that arrives after unmount", async () => {
    const { unmount } = render(<AboutCrowd />);
    const lateLoad = loadedImage.onload;
    unmount();
    await act(async () => lateLoad?.());
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("shows a stable fallback on image failure", () => {
    render(<AboutCrowd />);
    act(() => loadedImage.onerror?.());
    expect(screen.getByText("aboutCrowdUnavailable")).toBeVisible();
    expect(screen.getByRole("checkbox")).toBeDisabled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("falls back if canvas has no 2D context", async () => {
    mocks.create.mockReturnValue(null);
    render(<AboutCrowd />);
    await loadCrowd();
    expect(screen.getByText("aboutCrowdUnavailable")).toBeVisible();
  });
});
