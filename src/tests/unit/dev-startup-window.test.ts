import { EventEmitter } from "node:events";
import type { BrowserWindow } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDevLoadingWindow,
  createDevStartupWindow,
  devStartupDocument,
  waitForDevRendererFrame,
} from "@/services/dev-startup-window";

const native = vi.hoisted(() => ({ options: {}, bounds: {}, deny: vi.fn() }));
vi.mock("electron", () => ({
  BrowserWindow: class {
    webContents = Object.assign(new EventEmitter(), {
      setWindowOpenHandler: native.deny,
    });
    constructor(options: unknown) {
      native.options = options as object;
    }
    getBounds() {
      return { x: 0, y: 0, width: 496, height: 339 };
    }
    setBounds(bounds: object) {
      native.bounds = bounds;
    }
  },
  nativeTheme: { shouldUseDarkColors: true },
  screen: {
    getCursorScreenPoint: () => ({ x: 10, y: 20 }),
    getDisplayNearestPoint: () => ({
      workArea: { x: -100, y: 20, width: 400, height: 280 },
    }),
  },
}));

function windowMock() {
  const window = Object.assign(new EventEmitter(), {
    destroyed: false,
    isDestroyed: () => window.destroyed,
    isMinimized: vi.fn(() => false),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    destroy: vi.fn(() => {
      window.destroyed = true;
    }),
    loadURL: vi.fn(() => Promise.resolve()),
    webContents: Object.assign(new EventEmitter(), {
      isDestroyed: () => false,
      executeJavaScript: vi.fn<(...args: unknown[]) => Promise<number | null>>(
        () => Promise.resolve(null)
      ),
    }),
  });
  return window;
}

function fixture(
  prepareLoading?: (window: ReturnType<typeof windowMock>) => void
) {
  const loading = windowMock();
  prepareLoading?.(loading);
  const target = windowMock();
  const options = {
    createLoadingWindow: () => loading as unknown as BrowserWindow,
    document: devStartupDocument("AI 图片管理器", false),
    quit: vi.fn(),
    onSlow: vi.fn(),
    onError: vi.fn(),
    onShown: vi.fn(),
    onHandoff: vi.fn(),
  };
  const startup = createDevStartupWindow(options);
  startup.attach(target as unknown as BrowserWindow, () => true);
  return { loading, target, options, startup };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("development startup handoff", () => {
  it("uses a sandbox without preload and stays inside a small display work area", () => {
    const window = createDevLoadingWindow("AI 图片管理器", "assets/icon.ico");
    expect(native.options).toMatchObject({
      icon: "assets/icon.ico",
      show: false,
      useContentSize: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });
    expect(
      (native.options as { webPreferences: object }).webPreferences
    ).not.toHaveProperty("preload");
    expect(native.bounds).toEqual({ x: -100, y: 20, width: 400, height: 280 });
    const preventDefault = vi.fn();
    window.webContents.emit("will-navigate", { preventDefault });
    window.webContents.emit("will-redirect", { preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(2);
    expect(native.deny.mock.calls.at(-1)?.[0]()).toEqual({ action: "deny" });
  });
  it("automatically shows the loader and directs early requests to it", () => {
    const f = fixture();
    f.loading.emit("ready-to-show");
    f.startup.show();
    expect(f.loading.show).toHaveBeenCalledTimes(2);
    expect(f.options.onShown).toHaveBeenCalledOnce();
    expect(f.target.show).not.toHaveBeenCalled();
    f.startup.dispose();
  });

  it("shows the painted target before destroying the loader, only once", async () => {
    const f = fixture();
    const order: string[] = [];
    f.target.show.mockImplementation(() => {
      order.push("target");
    });
    f.loading.destroy.mockImplementation(() => {
      order.push("destroy");
    });
    f.target.webContents.executeJavaScript.mockResolvedValue(100);
    f.target.webContents.emit("dom-ready");
    await vi.waitFor(() =>
      expect(f.options.onHandoff).toHaveBeenCalledWith(100)
    );
    expect(order).toEqual(["target", "destroy"]);
    f.target.webContents.emit("dom-ready");
    f.startup.show();
    expect(f.target.show).toHaveBeenCalledOnce();
    expect(f.startup.pending).toBe(false);
    expect(f.options.quit).not.toHaveBeenCalled();
  });

  it("rejects stale first frames after replacement, navigation or shutdown", async () => {
    for (const reason of ["replace", "navigate", "quit"] as const) {
      const f = fixture();
      let resolve: (value: number) => void = () => undefined;
      f.target.webContents.executeJavaScript.mockImplementationOnce(
        () =>
          new Promise<number>((done) => {
            resolve = done;
          })
      );
      f.target.webContents.emit("dom-ready");
      if (reason === "replace") {
        f.startup.attach(windowMock() as unknown as BrowserWindow, () => true);
      } else if (reason === "navigate") {
        f.target.webContents.emit("did-start-loading");
      } else {
        f.startup.dispose();
      }
      resolve(100);
      await Promise.resolve();
      await Promise.resolve();
      expect(f.target.show).not.toHaveBeenCalled();
      expect(f.options.onHandoff).not.toHaveBeenCalled();
      f.startup.dispose();
    }
  });

  it("ignores a mark from a target whose owner changed", async () => {
    const f = fixture();
    f.startup.attach(f.target as unknown as BrowserWindow, () => false);
    f.target.webContents.executeJavaScript.mockResolvedValue(1);
    f.target.webContents.emit("dom-ready");
    await Promise.resolve();
    expect(f.target.show).not.toHaveBeenCalled();
    f.startup.dispose();
  });

  it("can observe an already loaded document and does not install duplicate probes", () => {
    const f = fixture();
    f.target.webContents.emit("did-finish-load");
    f.target.webContents.emit("dom-ready");
    expect(f.target.webContents.executeJavaScript).toHaveBeenCalledOnce();
    f.startup.dispose();
  });

  it("disposes safely after the target's native webContents getter is destroyed", () => {
    const f = fixture();
    const contents = f.target.webContents;
    Object.defineProperty(f.target, "webContents", {
      get: () => {
        if (f.target.destroyed) {
          throw new Error("Object has been destroyed");
        }
        return contents;
      },
    });
    f.target.destroyed = true;
    f.target.emit("closed");
    expect(f.startup.pending).toBe(false);
    expect(f.loading.destroy).toHaveBeenCalledOnce();
    expect(contents.listenerCount("dom-ready")).toBe(0);
  });

  it("reports loader document failure and still lets its close button quit", async () => {
    const error = new Error("document failed");
    const f = fixture((window) => window.loadURL.mockRejectedValueOnce(error));
    await vi.waitFor(() =>
      expect(f.options.onError).toHaveBeenCalledWith(error)
    );
    f.loading.emit("close");
    expect(f.options.quit).toHaveBeenCalledOnce();
    expect(f.target.show).not.toHaveBeenCalled();
    f.startup.dispose();
  });

  it("keeps the loader closable after a probe failure", async () => {
    const f = fixture();
    const error = new Error("renderer failed");
    f.target.webContents.executeJavaScript.mockRejectedValueOnce(error);
    f.target.webContents.emit("dom-ready");
    await vi.waitFor(() =>
      expect(f.options.onError).toHaveBeenCalledWith(error)
    );
    f.loading.emit("close");
    expect(f.options.quit).toHaveBeenCalledOnce();
    expect(f.target.show).not.toHaveBeenCalled();
    f.startup.dispose();
  });

  it("logs a slow startup once, and cancels timers and callbacks on disposal", () => {
    vi.useFakeTimers();
    const f = fixture();
    vi.advanceTimersByTime(90_000);
    expect(f.options.onSlow).toHaveBeenCalledOnce();
    expect(f.target.show).not.toHaveBeenCalled();
    f.startup.dispose();
    f.startup.dispose();
    f.loading.emit("ready-to-show");
    f.loading.emit("close");
    expect(f.loading.destroy).toHaveBeenCalledOnce();
    expect(f.loading.show).not.toHaveBeenCalled();
    expect(f.options.quit).not.toHaveBeenCalled();
    const second = fixture();
    second.startup.dispose();
    vi.advanceTimersByTime(30_000);
    expect(second.options.onSlow).not.toHaveBeenCalled();
  });

  it("escapes localized names and needs no external resources or scripts", () => {
    const html = devStartupDocument('<img src=x onerror="bad">', true);
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("<img");
    expect(html).toContain("default-src 'none'");
    expect(html).not.toContain("<script");
    expect(html).toContain("prefers-reduced-motion");
    expect(html).toContain(".spinner{animation:none}");
  });
});

describe("trusted renderer first-frame probe", () => {
  it("finds a mark that already exists without installing an observer", async () => {
    vi.stubGlobal("performance", {
      timeOrigin: 100,
      getEntriesByName: () => [{ startTime: 20 }],
    });
    expect(await waitForDevRendererFrame("paint", "cancel")).toBe(120);
  });

  it("observes buffered marks and disconnects on completion or cancellation", async () => {
    const disconnect = vi.fn();
    const observe = vi.fn();
    let receive: (entries: {
      getEntries(): { name: string; startTime: number }[];
    }) => void = () => undefined;
    vi.stubGlobal("performance", {
      timeOrigin: 100,
      getEntriesByName: () => [],
    });
    vi.stubGlobal(
      "PerformanceObserver",
      class {
        disconnect = disconnect;
        observe = observe;
        constructor(callback: typeof receive) {
          receive = callback;
        }
      }
    );
    const painted = waitForDevRendererFrame("paint", "cancel");
    expect(observe).toHaveBeenCalledWith({ type: "mark", buffered: true });
    receive({ getEntries: () => [{ name: "paint", startTime: 30 }] });
    expect(await painted).toBe(130);
    expect(disconnect).toHaveBeenCalledOnce();
    const cancelled = waitForDevRendererFrame("paint", "cancel");
    window.dispatchEvent(new Event("cancel"));
    expect(await cancelled).toBeNull();
    expect(disconnect).toHaveBeenCalledTimes(2);
    const navigated = waitForDevRendererFrame("paint", "cancel");
    window.dispatchEvent(new Event("pagehide"));
    expect(await navigated).toBeNull();
  });
});
