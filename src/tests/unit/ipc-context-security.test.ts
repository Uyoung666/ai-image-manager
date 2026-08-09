import { describe, expect, it } from "vitest";
import { ipcContext } from "@/ipc/context";

describe("IPC sender and origin validation", () => {
  it("accepts only the registered main frame and exact renderer origin", () => {
    const mainFrame = { url: "http://localhost:5173/#/gallery" };
    const webContents = { mainFrame };
    const browserWindow = {
      isDestroyed: () => false,
      webContents,
    };
    ipcContext.setMainWindow(
      browserWindow as never,
      "http://localhost:5173/index.html"
    );

    expect(
      ipcContext.isTrustedSender({
        sender: webContents,
        senderFrame: mainFrame,
      } as never)
    ).toBe(true);

    expect(
      ipcContext.isTrustedSender({
        sender: webContents,
        senderFrame: { url: "http://localhost:5173/#/gallery" },
      } as never)
    ).toBe(false);
    expect(
      ipcContext.isTrustedSender({
        sender: webContents,
        senderFrame: { url: "http://evil.example/" },
      } as never)
    ).toBe(false);
  });

  it("does not trust arbitrary file URLs in production", () => {
    const mainFrame = { url: "file:///app/renderer/index.html" };
    const webContents = { mainFrame };
    const browserWindow = {
      isDestroyed: () => false,
      webContents,
    };
    ipcContext.setMainWindow(
      browserWindow as never,
      "file:///app/renderer/index.html"
    );

    expect(ipcContext.isTrustedRendererUrl("file:///tmp/evil.html")).toBe(
      false
    );
  });
});
