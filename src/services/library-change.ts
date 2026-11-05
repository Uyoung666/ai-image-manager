import { BrowserWindow } from "electron";
import { invalidateCountCache } from "@/ipc/photos/handlers/listing";
import { invalidateIndexStatsCache } from "@/ipc/photos/handlers/stats";
import { requestAutoIndex } from "./ai-index-scheduler";

/** Publish only after the catalogue transaction has committed. */
export function notifyLibraryChange(
  photoId: number | null,
  event: "add" | "remove"
): void {
  invalidateCountCache();
  invalidateIndexStatsCache();
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("file-change", { type: event, photoId });
    win.webContents.send("ai-status-changed");
  }
  if (event === "add" && photoId !== null) {
    requestAutoIndex("watcher");
  }
}
