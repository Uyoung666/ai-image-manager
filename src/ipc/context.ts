import { os } from "@orpc/server";
import type { BrowserWindow, IpcMainEvent, IpcMainInvokeEvent } from "electron";

type IpcEvent = IpcMainEvent | IpcMainInvokeEvent;

class IPCContext {
  mainWindow: BrowserWindow | undefined;
  private trustedRendererUrl: URL | undefined;

  setMainWindow(window: BrowserWindow, trustedRendererUrl: string) {
    this.mainWindow = window;
    try {
      this.trustedRendererUrl = new URL(trustedRendererUrl);
    } catch {
      this.trustedRendererUrl = undefined;
    }
  }

  isTrustedRendererUrl(url: string): boolean {
    if (!this.trustedRendererUrl) {
      return false;
    }

    try {
      const candidate = new URL(url);
      const trusted = this.trustedRendererUrl;
      if (candidate.origin !== trusted.origin) {
        return false;
      }

      // A file:// renderer must remain on the exact bundled entry point. For
      // the dev server, same-origin route changes are expected and allowed.
      return trusted.protocol === "file:"
        ? candidate.pathname === trusted.pathname
        : true;
    } catch {
      return false;
    }
  }

  isTrustedSender(event: IpcEvent): boolean {
    const window = this.mainWindow;
    const frame = event.senderFrame;
    return Boolean(
      window &&
        !window.isDestroyed() &&
        event.sender === window.webContents &&
        frame &&
        frame === window.webContents.mainFrame &&
        this.isTrustedRendererUrl(frame.url)
    );
  }

  get mainWindowContext() {
    return os.middleware(({ next }) => {
      const window = this.mainWindow;
      if (!window) {
        throw new Error("Main window is not set in IPC context.");
      }
      return next({
        context: {
          window,
        },
      });
    });
  }
}

export const ipcContext = new IPCContext();
