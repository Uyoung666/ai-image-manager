import { ORPCError, os } from "@orpc/server";
import { BrowserWindow, dialog, type OpenDialogOptions } from "electron";
import { z } from "zod";
import { retryLibraryPhotoRefresh } from "@/services/library-content-refresh";
import { noteLibraryForegroundActivity as noteLibraryForegroundActivityService } from "@/services/library-foreground";
import {
  cancelLibraryTask as cancelLibraryTaskService,
  getLibraryHealth as getLibraryHealthService,
  getLibraryIssues as getLibraryIssuesService,
  getLibraryTask as getLibraryTaskService,
  inspectMissingRecordRemoval as inspectMissingRecordRemovalService,
  reconcileLibrary as reconcileLibraryService,
  removeMissingRecords as removeMissingRecordsService,
} from "@/services/library-maintenance";
import {
  applyLibraryRelink as applyLibraryRelinkService,
  getRelinkInspection as getRelinkInspectionService,
  inspectFolderRelink as inspectFolderRelinkService,
  inspectPhotoRelink as inspectPhotoRelinkService,
} from "@/services/library-relink";
import { performHardDelete } from "./mutations";

const OPERATION_ERROR = /^(LIBRARY|RELINK)_[A-Z_]+$/;
const id = z.number().int().positive();
const ids = z
  .array(id)
  .min(1)
  .max(1000)
  .transform((values) => [...new Set(values)]);
const offset = z.number().int().nonnegative().default(0);
const token = z.string().uuid();

async function operation<T>(run: () => T | Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    throw new ORPCError("BAD_REQUEST", {
      message: OPERATION_ERROR.test(message)
        ? message
        : "LIBRARY_OPERATION_FAILED",
    });
  }
}

async function selectPath(kind: "openFile" | "openDirectory") {
  const window = BrowserWindow.getFocusedWindow();
  const options: OpenDialogOptions = { properties: [kind, "dontAddToRecent"] };
  const result = window
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options);
  return result.canceled ? null : (result.filePaths[0] ?? null);
}

export const getLibraryHealth = os
  .input(z.object({ folderId: id.optional() }).default({}))
  .handler(({ input }) =>
    operation(() => getLibraryHealthService(input.folderId))
  );

export const getLibraryIssues = os
  .input(
    z
      .object({
        folderId: id.optional(),
        status: z
          .enum(["all", "offline", "missing", "inaccessible", "failed"])
          .default("all"),
        offset: z.number().int().nonnegative().default(0),
      })
      .default({ status: "all", offset: 0 })
  )
  .handler(({ input }) => operation(() => getLibraryIssuesService(input)));

export const noteLibraryForegroundActivity = os
  .input(z.object({}).default({}))
  .handler(() => {
    noteLibraryForegroundActivityService();
    return { recorded: true };
  });

export const reconcileLibrary = os
  .input(
    z.object({ folderId: id.optional(), photoIds: ids.optional() }).default({})
  )
  .handler(({ input }) => operation(() => reconcileLibraryService(input)));

export const getLibraryTask = os
  .input(z.object({ taskId: token, offset }))
  .handler(({ input }) =>
    operation(() => getLibraryTaskService(input.taskId, input.offset))
  );

export const cancelLibraryTask = os
  .input(z.object({ taskId: token }))
  .handler(({ input }) =>
    operation(() => cancelLibraryTaskService(input.taskId))
  );

export const inspectPhotoRelink = os
  .input(z.object({ photoId: id }))
  .handler(({ input }) =>
    operation(async () => {
      const chosen = await selectPath("openFile");
      return chosen ? inspectPhotoRelinkService(input.photoId, chosen) : null;
    })
  );

export const inspectFolderRelink = os
  .input(z.object({ folderId: id }))
  .handler(({ input }) =>
    operation(async () => {
      const chosen = await selectPath("openDirectory");
      return chosen ? inspectFolderRelinkService(input.folderId, chosen) : null;
    })
  );

export const getRelinkInspection = os
  .input(z.object({ token, offset }))
  .handler(({ input }) =>
    operation(() => getRelinkInspectionService(input.token, input.offset))
  );

export const applyLibraryRelink = os
  .input(z.object({ token, confirmedPhotoIds: z.array(id).max(100_000) }))
  .handler(({ input }) =>
    operation(() =>
      applyLibraryRelinkService(input.token, input.confirmedPhotoIds)
    )
  );

export const inspectMissingRecordRemoval = os
  .input(z.object({ photoIds: ids }))
  .handler(({ input }) =>
    operation(() => inspectMissingRecordRemovalService(input.photoIds))
  );

export const removeMissingRecords = os
  .input(z.object({ token }))
  .handler(({ input }) =>
    operation(() => removeMissingRecordsService(input.token, performHardDelete))
  );

export const retryPhotoRefresh = os
  .input(z.object({ photoIds: ids }))
  .handler(({ input }) =>
    operation(async () => {
      const queuedIds: number[] = [];
      const failedIds: number[] = [];
      for (const photoId of input.photoIds) {
        const queued = await retryLibraryPhotoRefresh(photoId).catch(
          () => false
        );
        (queued ? queuedIds : failedIds).push(photoId);
      }
      return { queued: queuedIds.length, queuedIds, failedIds };
    })
  );
