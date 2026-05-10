import { os } from "@orpc/server";
import { BrowserWindow, dialog, shell } from "electron";
import { z } from "zod";
import { openExternalLinkInputSchema } from "./schemas";

export const openExternalLink = os
  .input(openExternalLinkInputSchema)
  .handler(({ input }) => {
    const { url } = input;
    shell.openExternal(url);
  });

export const openFolderDialog = os.handler(async () => {
  const win = BrowserWindow.getFocusedWindow();
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
