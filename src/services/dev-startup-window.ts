import { BrowserWindow, nativeTheme, screen } from "electron";
import { DEV_RENDERER_FIRST_FRAME_MARK } from "@/utils/dev-startup-readiness";

const CANCEL_WAIT_EVENT = "aim:cancel-dev-startup-wait";
const HTML_ESCAPE_PATTERN = /[&<>"']/g;
const HTML_ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Serialized into the trusted main renderer, with no bridge or IPC surface. */
export function waitForDevRendererFrame(mark: string, cancelEvent: string) {
  return new Promise<number | null>((resolve) => {
    const existing = performance.getEntriesByName(mark)[0];
    if (existing) {
      resolve(performance.timeOrigin + existing.startTime);
      return;
    }
    const finish = (at: number | null) => {
      observer.disconnect();
      window.removeEventListener("pagehide", cancel);
      window.removeEventListener(cancelEvent, cancel);
      resolve(at);
    };
    const cancel = () => finish(null);
    const observer = new PerformanceObserver((entries) => {
      const entry = entries.getEntries().find((item) => item.name === mark);
      if (entry) {
        finish(performance.timeOrigin + entry.startTime);
      }
    });
    window.addEventListener("pagehide", cancel, { once: true });
    window.addEventListener(cancelEvent, cancel, { once: true });
    observer.observe({ type: "mark", buffered: true });
  });
}

function escapeHtml(value: string) {
  return value.replace(
    HTML_ESCAPE_PATTERN,
    (character) => HTML_ENTITIES[character]
  );
}

export function devStartupDocument(title: string, reduceMotion: boolean) {
  const name = escapeHtml(title);
  return `<!doctype html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<meta name="color-scheme" content="light dark"><title>${name}</title>
<style>
*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden}
body{background:#fbfbfc;color:#17181a;font:16px system-ui;display:grid;place-items:center}
section{max-width:100%;padding:24px;text-align:center;overflow-wrap:anywhere}
.spinner{width:36px;height:36px;margin:0 auto 20px;border:3px solid currentColor;border-right-color:transparent;border-radius:50%;animation:spin 1s linear infinite;opacity:.65}
@keyframes spin{to{transform:rotate(360deg)}}
@media(prefers-color-scheme:dark){body{background:#08090a;color:#f5f5f5}}
@media(prefers-reduced-motion:reduce){.spinner{animation:none}}
${reduceMotion ? ".spinner{animation:none}" : ""}
</style></head><body><section data-dev-startup role="status" aria-label="${name}"><div class="spinner" aria-hidden="true"></div><div>${name}</div></section></body></html>`;
}

export function createDevLoadingWindow(title: string, icon?: string) {
  const area = screen.getDisplayNearestPoint(
    screen.getCursorScreenPoint()
  ).workArea;
  const window = new BrowserWindow({
    title,
    icon,
    useContentSize: true,
    width: Math.min(480, area.width),
    height: Math.min(300, Math.max(100, area.height - 64)),
    show: false,
    resizable: false,
    maximizable: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#08090a" : "#fbfbfc",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  const bounds = window.getBounds();
  const width = Math.min(bounds.width, area.width);
  const height = Math.min(bounds.height, area.height);
  window.setBounds({
    width,
    height,
    x: area.x + Math.floor((area.width - width) / 2),
    y: area.y + Math.floor((area.height - height) / 2),
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("will-redirect", (event) => event.preventDefault());
  return window;
}

export interface DevStartupOptions {
  createLoadingWindow: () => BrowserWindow;
  document: string;
  onError: (error: unknown) => void;
  onHandoff: (firstFrameAt: number) => void;
  onShown: () => void;
  onSlow: () => void;
  quit: () => void;
}

/** Owns only the first development frame, never subsequent HMR or tray hides. */
export function createDevStartupWindow(options: DevStartupOptions) {
  const loading = options.createLoadingWindow();
  let pending = true;
  let target: BrowserWindow | null = null;
  let current = () => false;
  let generation = 0;
  let detach: () => void = () => undefined;
  const timeout = setTimeout(options.onSlow, 30_000);
  const showLoading = () => {
    if (!(pending && !loading.isDestroyed())) {
      return;
    }
    if (loading.isMinimized()) {
      loading.restore();
    }
    loading.show();
    loading.focus();
  };
  const readyToShow = () => {
    showLoading();
    if (pending) {
      options.onShown();
    }
  };
  const close = () => {
    if (pending) {
      options.quit();
    }
  };
  loading.once("ready-to-show", readyToShow);
  loading.on("close", close);
  loading
    .loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(options.document)}`
    )
    .catch((error) => {
      if (pending) {
        options.onError(error);
      }
    });

  const cancelWait = () => {
    if (target && !target.isDestroyed() && !target.webContents.isDestroyed()) {
      target.webContents
        .executeJavaScript(
          `window.dispatchEvent(new Event(${JSON.stringify(CANCEL_WAIT_EVENT)}))`
        )
        .catch(() => undefined);
    }
  };
  const dispose = () => {
    if (!pending) {
      return;
    }
    pending = false;
    generation++;
    clearTimeout(timeout);
    detach();
    cancelWait();
    loading.removeListener("ready-to-show", readyToShow);
    loading.removeListener("close", close);
    if (!loading.isDestroyed()) {
      loading.destroy();
    }
  };

  return {
    get pending() {
      return pending;
    },
    show: showLoading,
    dispose,
    attach(window: BrowserWindow, isCurrent: () => boolean) {
      if (!pending) {
        return;
      }
      detach();
      cancelWait();
      target = window;
      const contents = window.webContents;
      current = isCurrent;
      generation++;
      let probedGeneration = -1;
      const probe = () => {
        if (probedGeneration === generation) {
          return;
        }
        const probeGeneration = generation;
        probedGeneration = generation;
        contents
          .executeJavaScript(
            `(${waitForDevRendererFrame.toString()})(${JSON.stringify(DEV_RENDERER_FIRST_FRAME_MARK)},${JSON.stringify(CANCEL_WAIT_EVENT)})`
          )
          .then((at: number | null) => {
            if (
              !(
                at !== null &&
                pending &&
                probeGeneration === generation &&
                current() &&
                target === window &&
                !window.isDestroyed()
              )
            ) {
              return;
            }
            if (window.isMinimized()) {
              window.restore();
            }
            window.show();
            window.focus();
            try {
              options.onHandoff(at);
            } finally {
              dispose();
            }
          })
          .catch((error) => {
            if (
              pending &&
              target === window &&
              current() &&
              !window.isDestroyed()
            ) {
              options.onError(error);
            }
          });
      };
      const navigation = () => {
        generation++;
      };
      contents.on("dom-ready", probe);
      contents.on("did-finish-load", probe);
      contents.on("did-start-loading", navigation);
      window.once("closed", dispose);
      detach = () => {
        contents.removeListener("dom-ready", probe);
        contents.removeListener("did-finish-load", probe);
        contents.removeListener("did-start-loading", navigation);
        window.removeListener("closed", dispose);
      };
    },
  };
}
