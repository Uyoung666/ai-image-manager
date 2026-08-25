import { describe, expect, it, vi } from "vitest";
import {
  createBeforeQuitHandler,
  destroyTraySafely,
  prepareForQuit,
  showOrCreateWindow,
  type WindowLifecycleHandle,
} from "@/services/window-tray-lifecycle";

function createWindowMock(
  overrides: Partial<WindowLifecycleHandle> = {}
): WindowLifecycleHandle {
  return {
    focus: vi.fn(),
    isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => false),
    restore: vi.fn(),
    show: vi.fn(),
    ...overrides,
  };
}

describe("window and tray lifecycle", () => {
  it("destroys a tray and tolerates an already-cleared reference", () => {
    const destroy = vi.fn();
    const onError = vi.fn();
    const tray = { destroy };

    destroyTraySafely(tray, onError);
    destroyTraySafely(null, onError);

    expect(destroy).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
  });

  it("reports tray destroy failures without throwing", () => {
    const error = new Error("destroy failed");
    const onError = vi.fn();

    const destroyed = destroyTraySafely(
      {
        destroy: () => {
          throw error;
        },
      },
      onError
    );

    expect(destroyed).toBe(false);
    expect(onError).toHaveBeenCalledWith(error);
  });

  it("shows and focuses an existing minimized window", () => {
    const window = createWindowMock({ isMinimized: vi.fn(() => true) });

    showOrCreateWindow({
      createWindow: vi.fn(),
      isQuitting: false,
      window,
    });

    expect(window.restore).toHaveBeenCalledOnce();
    expect(window.show).toHaveBeenCalledOnce();
    expect(window.focus).toHaveBeenCalledOnce();
  });

  it("recreates a destroyed window", () => {
    const createWindow = vi.fn();
    const window = createWindowMock({ isDestroyed: vi.fn(() => true) });

    showOrCreateWindow({
      createWindow,
      isQuitting: false,
      window,
    });

    expect(createWindow).toHaveBeenCalledOnce();
    expect(window.show).not.toHaveBeenCalled();
  });

  it("does not recreate or show a window while quitting", () => {
    const createWindow = vi.fn();
    const window = createWindowMock({ isDestroyed: vi.fn(() => true) });

    showOrCreateWindow({
      createWindow,
      isQuitting: true,
      window,
    });

    expect(createWindow).not.toHaveBeenCalled();
    expect(window.show).not.toHaveBeenCalled();
  });

  it("marks the app as quitting before destroying the tray", () => {
    const events: string[] = [];

    prepareForQuit({
      destroyTray: () => {
        events.push("destroy-tray");
      },
      markQuitting: () => {
        events.push("mark-quitting");
      },
    });

    expect(events).toEqual(["mark-quitting", "destroy-tray"]);
  });

  it("waits for cleanup once and allows the second quit event", async () => {
    let finishCleanup: (() => void) | undefined;
    const cleanup = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishCleanup = resolve;
        })
    );
    const destroyTray = vi.fn();
    const markQuitting = vi.fn();
    const onCleanupError = vi.fn();
    const requestQuit = vi.fn();
    const firstEvent = { preventDefault: vi.fn() };
    const duplicateEvent = { preventDefault: vi.fn() };
    const finalEvent = { preventDefault: vi.fn() };
    const handler = createBeforeQuitHandler({
      cleanup,
      destroyTray,
      markQuitting,
      onCleanupError,
      requestQuit,
    });

    handler(firstEvent);
    handler(duplicateEvent);

    expect(firstEvent.preventDefault).toHaveBeenCalledOnce();
    expect(duplicateEvent.preventDefault).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();

    finishCleanup?.();
    await vi.waitFor(() => {
      expect(requestQuit).toHaveBeenCalledOnce();
    });

    handler(finalEvent);
    expect(finalEvent.preventDefault).not.toHaveBeenCalled();
    expect(onCleanupError).not.toHaveBeenCalled();
    expect(destroyTray).toHaveBeenCalledTimes(3);
    expect(markQuitting).toHaveBeenCalledTimes(3);
  });

  it("still requests the final quit when cleanup fails", async () => {
    const error = new Error("cleanup failed");
    const onCleanupError = vi.fn();
    const requestQuit = vi.fn();
    const handler = createBeforeQuitHandler({
      cleanup: () => Promise.reject(error),
      destroyTray: vi.fn(),
      markQuitting: vi.fn(),
      onCleanupError,
      requestQuit,
    });

    handler({ preventDefault: vi.fn() });

    await vi.waitFor(() => {
      expect(requestQuit).toHaveBeenCalledOnce();
    });
    expect(onCleanupError).toHaveBeenCalledWith(error);
  });
});
