import { act, render, screen } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getWanderSession,
  getWanderSettings,
  saveWanderSessionToAlbum,
  setWanderSettings,
} from "@/actions/wander";
import { IPC_CHANNELS } from "@/constants";
import { useWander, WanderProvider } from "@/providers/WanderProvider";
import {
  DEFAULT_WANDER_SETTINGS,
  type WanderSession,
  type WanderSettings,
} from "@/types/wander";

const { mockPathname, aiStatus } = vi.hoisted(() => ({
  mockPathname: { value: "/" },
  aiStatus: { isRunning: false },
}));

interface TestOverlayProps {
  onRoundComplete?: () => void;
  onSave?: () => void;
  roundNumber?: number;
  session?: WanderSession;
}

let overlayProps: TestOverlayProps | null = null;

vi.mock("@tanstack/react-router", () => ({
  useLocation: () => ({ pathname: mockPathname.value }),
}));

vi.mock("@/actions/wander", () => ({
  getWanderSession: vi.fn(),
  getWanderSettings: vi.fn(),
  saveWanderSessionToAlbum: vi.fn(),
  setWanderSettings: vi.fn(),
}));

vi.mock("@/hooks/use-global-ai-status", () => ({
  useGlobalAiStatus: () => aiStatus,
}));

vi.mock("sonner", () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/components/wander/WanderOverlay", () => ({
  WanderOverlay: (props: TestOverlayProps) => {
    overlayProps = props;
    return <div data-testid="wander-overlay" />;
  },
}));

let api: ReturnType<typeof useWander> | null = null;

function Probe() {
  api = useWander();
  return null;
}

function renderProvider() {
  render(
    <WanderProvider>
      <Probe />
    </WanderProvider>
  );
}

function makeSession(overrides: Partial<WanderSession> = {}): WanderSession {
  return {
    mode: "rediscovery",
    photos: [
      {
        id: 1,
        path: "C:/1.jpg",
        filename: "1.jpg",
        width: 800,
        height: 600,
        fileDate: 1,
        thumbnailPath: null,
        isFavorite: false,
        isIndexed: true,
      },
      {
        id: 2,
        path: "C:/2.jpg",
        filename: "2.jpg",
        width: 800,
        height: 600,
        fileDate: 2,
        thumbnailPath: null,
        isFavorite: false,
        isIndexed: true,
      },
    ],
    titleKey: "wander.title.rediscovery",
    ...overrides,
  };
}

function autoSettings(): WanderSettings {
  return { ...DEFAULT_WANDER_SETTINGS, enabled: true, idleMinutes: 15 };
}

interface ElectronApi {
  electronAPI?: {
    getWanderLifecycleState: () => { eligible: boolean } | null;
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

// Fires fake timers and flushes the microtasks their callbacks schedule.
async function advance(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
  });
}

function requireApi() {
  if (!api) {
    throw new Error("useWander probe was not mounted");
  }
  return api;
}

// Invokes an overlay callback and flushes the microtasks it schedules.
async function runOverlayAction(action: () => void) {
  await act(async () => {
    action();
    await Promise.resolve();
  });
}

describe("WanderProvider", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    overlayProps = null;
    api = null;
    mockPathname.value = "/";
    aiStatus.isRunning = false;
    (window as unknown as ElectronApi).electronAPI = {
      getWanderLifecycleState: () => ({ eligible: true }),
    };
    vi.mocked(getWanderSettings).mockResolvedValue(autoSettings());
    vi.mocked(getWanderSession).mockResolvedValue(makeSession());
    vi.mocked(saveWanderSessionToAlbum).mockResolvedValue({ albumId: 1 });
    vi.mocked(setWanderSettings).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    (window as unknown as ElectronApi).electronAPI = undefined;
  });

  it("resets the idle timer on user activity", async () => {
    renderProvider();
    await flush();

    await advance(10 * 60_000);
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown"));
    });

    await advance(10 * 60_000);
    expect(getWanderSession).not.toHaveBeenCalled();

    await advance(5 * 60_000);
    expect(getWanderSession).toHaveBeenCalled();
  });

  it("auto-starts once when the idle threshold is reached", async () => {
    renderProvider();
    await flush();

    await advance(15 * 60_000);

    expect(getWanderSession).toHaveBeenCalled();
    expect(api?.active).toBe(true);
    expect(screen.getByTestId("wander-overlay")).toBeInTheDocument();

    // A further idle window does not start another session while one is active.
    await advance(30 * 60_000);
    expect(getWanderSession).toHaveBeenCalledTimes(2); // initial + prefetch
  });

  it("does not auto-start when wander is disabled", async () => {
    vi.mocked(getWanderSettings).mockResolvedValue({
      ...DEFAULT_WANDER_SETTINGS,
      enabled: false,
    });
    renderProvider();
    await flush();

    await advance(30 * 60_000);
    expect(getWanderSession).not.toHaveBeenCalled();
  });

  it("does not auto-start off the home route", async () => {
    mockPathname.value = "/albums";
    renderProvider();
    await flush();

    await advance(30 * 60_000);
    expect(getWanderSession).not.toHaveBeenCalled();
  });

  it("does not auto-start while the window is ineligible", async () => {
    (window as unknown as ElectronApi).electronAPI = {
      getWanderLifecycleState: () => ({ eligible: false }),
    };
    renderProvider();
    await flush();

    await advance(30 * 60_000);
    expect(getWanderSession).not.toHaveBeenCalled();
  });

  it("re-timers a full idle delay after eligibility returns", async () => {
    (window as unknown as ElectronApi).electronAPI = {
      getWanderLifecycleState: () => ({ eligible: false }),
    };
    renderProvider();
    await flush();

    await advance(10 * 60_000);
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            channel: IPC_CHANNELS.WANDER_LIFECYCLE,
            eligible: true,
            reason: "window-focus",
          },
        })
      );
    });

    // Only 10 of the required 15 minutes have passed since becoming eligible.
    await advance(10 * 60_000);
    expect(getWanderSession).not.toHaveBeenCalled();

    await advance(5 * 60_000);
    expect(getWanderSession).toHaveBeenCalled();
  });

  it("does not auto-start while an AI task is running", async () => {
    aiStatus.isRunning = true;
    renderProvider();
    await flush();

    await advance(30 * 60_000);
    expect(getWanderSession).not.toHaveBeenCalled();
  });

  it("does not auto-start while a blocking surface is open", async () => {
    renderProvider();
    await flush();
    const blocker = document.createElement("div");
    blocker.setAttribute("data-wander-blocking", "true");
    document.body.appendChild(blocker);

    await advance(30 * 60_000);
    expect(getWanderSession).not.toHaveBeenCalled();

    blocker.remove();
    await advance(15 * 60_000);
    expect(getWanderSession).toHaveBeenCalled();
  });

  it("silently resets the idle timer and retries when an automatic fetch yields no photos", async () => {
    vi.mocked(getWanderSession).mockResolvedValue(makeSession({ photos: [] }));
    renderProvider();
    await flush();

    await advance(15 * 60_000);
    expect(getWanderSession).toHaveBeenCalledTimes(1);

    await advance(15 * 60_000);
    expect(getWanderSession).toHaveBeenCalledTimes(2);
    expect(toast.info).not.toHaveBeenCalled();
  });

  it("prefetches the next round and promotes it on round completion", async () => {
    let callCount = 0;
    vi.mocked(getWanderSession).mockImplementation(() => {
      callCount += 1;
      if (callCount === 1) {
        return Promise.resolve(makeSession({ mode: "rediscovery" }));
      }
      return Promise.resolve(makeSession({ mode: "theme" }));
    });
    renderProvider();
    await flush();

    await act(async () => {
      await requireApi().start();
    });
    expect(overlayProps?.session?.mode).toBe("rediscovery");

    await runOverlayAction(() =>
      (overlayProps as { onRoundComplete: () => void }).onRoundComplete()
    );

    expect(overlayProps?.session?.mode).toBe("theme");
    expect(overlayProps?.roundNumber).toBe(2);
  });

  it("keeps wandering and stays mounted after saving the current round", async () => {
    renderProvider();
    await flush();

    await act(async () => {
      await requireApi().start();
    });
    expect(screen.getByTestId("wander-overlay")).toBeInTheDocument();

    await runOverlayAction(() =>
      (overlayProps as { onSave: () => void }).onSave()
    );

    expect(saveWanderSessionToAlbum).toHaveBeenCalledTimes(1);
    expect(saveWanderSessionToAlbum).toHaveBeenCalledWith({
      photoIds: [1, 2],
      title: "wander.title.rediscovery",
    });
    expect(screen.getByTestId("wander-overlay")).toBeInTheDocument();
    expect(api?.active).toBe(true);
  });

  it("closes after consecutive round failures", async () => {
    let callCount = 0;
    vi.mocked(getWanderSession).mockImplementation(() => {
      callCount += 1;
      if (callCount === 1) {
        return Promise.resolve(makeSession());
      }
      return Promise.resolve(makeSession({ photos: [] }));
    });
    renderProvider();
    await flush();

    await act(async () => {
      await requireApi().start();
    });
    expect(screen.getByTestId("wander-overlay")).toBeInTheDocument();

    await runOverlayAction(() =>
      (overlayProps as { onRoundComplete: () => void }).onRoundComplete()
    );
    await advance(1000);
    await advance(1000);
    await advance(1000);

    expect(screen.queryByTestId("wander-overlay")).not.toBeInTheDocument();
    expect(api?.active).toBe(false);
    expect(toast.error).toHaveBeenCalled();
  });

  it("rolls back preferences when saving settings fails", async () => {
    vi.mocked(setWanderSettings).mockRejectedValueOnce(new Error("nope"));
    renderProvider();
    await flush();

    await act(async () => {
      await expect(
        requireApi().updatePreference("idleMinutes", 30)
      ).rejects.toThrow();
    });
    expect(api?.preferences.idleMinutes).toBe(15);
    expect(toast.error).toHaveBeenCalled();
  });
});
