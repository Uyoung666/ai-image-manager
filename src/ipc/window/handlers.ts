import { os } from "@orpc/server";
import { z } from "zod";
import { ipcContext } from "../context";

export const minimizeWindow = os
  .use(ipcContext.mainWindowContext)
  .handler(({ context }) => {
    const { window } = context;

    window.minimize();
  });

export const maximizeWindow = os
  .use(ipcContext.mainWindowContext)
  .handler(({ context }) => {
    const { window } = context;

    if (window.isMaximized()) {
      window.unmaximize();
    } else {
      window.maximize();
    }
  });

export const closeWindow = os
  .use(ipcContext.mainWindowContext)
  .handler(({ context }) => {
    const { window } = context;

    window.close();
  });

export const isWindowMaximized = os
  .use(ipcContext.mainWindowContext)
  .handler(({ context }) => {
    const { window } = context;

    return window.isMaximized();
  });

export const setZoomFactor = os
  .use(ipcContext.mainWindowContext)
  .input(z.object({ scale: z.number() }))
  .handler(({ context, input }) => {
    const { window } = context;

    // Clamp to a sane range — the settings UI offers 80%–130%, but guard
    // against out-of-bounds IPC callers.
    const scale = Math.min(2, Math.max(0.5, input.scale));
    window.webContents.setZoomFactor(scale);
  });
