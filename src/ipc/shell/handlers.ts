import fs from "node:fs";
import { os } from "@orpc/server";
import { BrowserWindow, dialog, nativeImage, shell } from "electron";
import { z } from "zod";
import { openExternalLinkInputSchema } from "./schemas";

export const openExternalLink = os
  .input(openExternalLinkInputSchema)
  .handler(({ input }) => {
    const { url } = input;
    shell.openExternal(url);
  });

export const openFolderDialog = os.handler(async () => {
  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  if (!win) {
    return { path: null };
  }
  const result = await dialog.showOpenDialog(win, {
    properties: ["openDirectory"],
    title: "选择照片文件夹",
  });
  return { path: result.canceled ? null : result.filePaths[0] || null };
});

export const openInExplorer = os
  .input(z.object({ path: z.string().min(1) }))
  .handler(({ input }) => {
    shell.showItemInFolder(input.path);
  });

export const saveFileDialog = os
  .input(
    z.object({
      defaultName: z.string().optional().default("export.zip"),
      title: z.string().optional().default("保存文件"),
    })
  )
  .handler(async ({ input }) => {
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    if (!win) {
      return { path: null };
    }
    const result = await dialog.showSaveDialog(win, {
      title: input.title,
      defaultPath: input.defaultName,
      filters: [
        { name: "ZIP 归档", extensions: ["zip"] },
        { name: "所有文件", extensions: ["*"] },
      ],
    });
    return { path: result.canceled ? null : result.filePath || null };
  });

export const startFileDrag = os
  .input(z.object({ filePath: z.string().min(1), iconPath: z.string().optional() }))
  .handler(({ input }) => {
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    if (!win) return;
    if (!fs.existsSync(input.filePath)) return;

    let icon: Electron.NativeImage;
    if (input.iconPath && fs.existsSync(input.iconPath)) {
      icon = nativeImage.createFromPath(input.iconPath).resize({ width: 64, height: 64 });
    } else {
      icon = nativeImage.createEmpty();
    }

    win.webContents.startDrag({
      file: input.filePath,
      icon,
    });
  });
