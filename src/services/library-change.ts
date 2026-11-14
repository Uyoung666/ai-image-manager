import { BrowserWindow } from "electron";
import { invalidateCountCache } from "@/ipc/photos/handlers/listing";
import { invalidateIndexStatsCache } from "@/ipc/photos/handlers/stats";
import { registerGalleryCleanup } from "@/utils/gallery-lifecycle";
import { requestAutoIndex } from "./ai-index-scheduler";

type Change = "add" | "remove" | "update" | "status";
let pending:
  | { photoId: number | null; type: Change; index: boolean }
  | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;

function flushLibraryChange(): void {
  timer = undefined;
  const change = pending;
  pending = undefined;
  if (!change) {
    return;
  }
  invalidateCountCache();
  invalidateIndexStatsCache();
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("file-change", {
      type: change.type,
      photoId: change.photoId,
    });
    win.webContents.send("ai-status-changed");
  }
  if (change.index) {
    requestAutoIndex("watcher");
  }
}

/** Coalesce committed catalogue changes without refetching inactive pages. */
export function notifyLibraryChange(
  photoId: number | null,
  event: Change
): void {
  const index = event === "update" || (event === "add" && photoId !== null);
  pending = pending
    ? { photoId: null, type: "update", index: pending.index || index }
    : { photoId, type: event, index };
  if (!timer) {
    timer = setTimeout(flushLibraryChange, 100);
    timer.unref?.();
  }
}

registerGalleryCleanup(() => {
  clearTimeout(timer);
  timer = undefined;
  pending = undefined;
});
