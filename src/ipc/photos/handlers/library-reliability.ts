import { ORPCError, os } from "@orpc/server";
import { BrowserWindow, dialog, type OpenDialogOptions } from "electron";
import { z } from "zod";
import { retryLibraryPhotoRefresh } from "@/services/library-content-refresh";
import { noteLibraryForegroundActivity as noteLibraryForegroundActivityService } from "@/services/library-foreground";
import {
  beginApplyLibraryRelink,
  beginLibraryRelink,
  cancelLibraryTask as cancelLibraryTaskService,
  dismissLibraryTask as dismissLibraryTaskService,
  getActiveLibraryTask,
  getLibraryAttention as getLibraryAttentionService,
  getLibraryHealth as getLibraryHealthService,
  getLibraryPhotoMoveCandidates,
  getLibraryPhotos as getLibraryPhotosService,
  getLibraryTask as getLibraryTaskService,
  inspectMissingRecordRemoval as inspectMissingRecordRemovalService,
  reconcileLibrary as reconcileLibraryService,
  removeMissingRecords as removeMissingRecordsService,
  retryLibraryRelink as retryLibraryRelinkService,
  retryLibrarySourceUpdates as retryLibrarySourceUpdatesService,
} from "@/services/library-maintenance";
import { getRelinkInspection as getRelinkInspectionService } from "@/services/library-relink";
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

export const getLibraryAttention = os
  .input(z.object({}).default({}))
  .handler(() => operation(getLibraryAttentionService));

export const getLibraryPhotos = os
  .input(
    z
      .object({
        folderId: id.optional(),
        photoId: id.optional(),
        query: z.string().max(1000).optional(),
        unassigned: z.boolean().optional(),
        status: z
          .enum([
            "attention",
            "all",
            "move",
            "unverified",
            "available",
            "offline",
            "missing",
            "inaccessible",
            "pending",
            "failed",
          ])
          .default("attention"),
        offset,
      })
      .default({ status: "attention", offset: 0 })
  )
  .handler(({ input }) => operation(() => getLibraryPhotosService(input)));

export const getLibraryMoveCandidates = os
  .input(z.object({ photoId: id }))
  .handler(({ input }) =>
    operation(() => getLibraryPhotoMoveCandidates(input.photoId))
  );

export const getActiveLibraryTaskHandler = os
  .input(z.object({}).default({}))
  .handler(() => operation(getActiveLibraryTask));

export const beginRelink = os
  .input(
    z
      .object({
        photoId: id.optional(),
        folderId: id.optional(),
        candidatePath: z.string().max(32_768).optional(),
      })
      .refine((value) => Boolean(value.photoId) !== Boolean(value.folderId))
      .refine((value) => !value.candidatePath || Boolean(value.photoId))
  )
  .handler(({ input }) =>
    operation(async () => {
      const selected =
        input.candidatePath ??
        (await selectPath(input.photoId ? "openFile" : "openDirectory"));
      return selected ? beginLibraryRelink(input, selected) : null;
    })
  );

export const beginApplyRelink = os
  .input(z.object({ token, confirmedPhotoIds: z.array(id).max(100_000) }))
  .handler(({ input }) =>
    operation(() =>
      beginApplyLibraryRelink(input.token, input.confirmedPhotoIds)
    )
  );

export const getLibraryHealth = os
  .input(z.object({ folderId: id.optional() }).default({}))
  .handler(({ input }) =>
    operation(() => getLibraryHealthService(input.folderId))
  );

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

export const getRelinkInspection = os
  .input(
    z.object({
      token,
      offset,
      status: z
        .enum([
          "matched",
          "unverified",
          "missing",
          "mismatch",
          "conflict",
          "inaccessible",
        ])
        .optional(),
    })
  )
  .handler(({ input }) =>
    operation(() =>
      getRelinkInspectionService(input.token, input.offset, input.status)
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
  .input(
    z.object({
      photoIds: ids,
      mode: z.enum(["retry", "preview", "analysis"]).optional(),
    })
  )
  .handler(({ input }) =>
    operation(async () => {
      const queuedIds: number[] = [];
      const failedIds: number[] = [];
      for (const photoId of input.photoIds) {
        const queued = await retryLibraryPhotoRefresh(
          photoId,
          input.mode
        ).catch(() => false);
        (queued ? queuedIds : failedIds).push(photoId);
      }
      return { queued: queuedIds.length, queuedIds, failedIds };
    })
  );

export const dismissLibraryTask = os
  .input(z.object({ taskId: token }))
  .handler(({ input }) =>
    operation(() => dismissLibraryTaskService(input.taskId))
  );

export const retryLibraryRelink = os
  .input(z.object({ taskId: token }))
  .handler(({ input }) =>
    operation(() => retryLibraryRelinkService(input.taskId))
  );

export const retryLibrarySourceUpdates = os
  .input(z.object({ folderId: id }))
  .handler(({ input }) =>
    operation(() => retryLibrarySourceUpdatesService(input.folderId))
  );
