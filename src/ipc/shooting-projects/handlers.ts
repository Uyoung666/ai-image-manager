import { ORPCError, os } from "@orpc/server";
import { shell } from "electron";
import {
  addShootingProjectToLibrary,
  inspectShootingProjectLibrary,
  ShootingProjectLibraryError,
  stopShootingProjectLibraryTasks,
} from "@/services/shooting-project-library";
import {
  cancelShootingProjectOutput,
  createShootingProjectOutput,
  inspectShootingProjectOutput,
  listShootingProjectOutputs,
  retryShootingProjectOutput,
  ShootingProjectOutputError,
  stopShootingProjectOutputTasks,
} from "@/services/shooting-project-output";
import {
  archiveShootingProject,
  clearShootingProjectPreviews,
  commitShootingProjectRelink,
  createShootingProject,
  deleteShootingProject,
  getShootingProjectWorkspace,
  inspectShootingProjectRelink,
  inspectShootingProjectSource,
  listShootingProjects,
  openShootingProject,
  prepareShootingProject,
  prioritizeShootingProjectPreviews,
  renameShootingProject,
  ShootingProjectError,
  saveShootingProjectBrowse,
  setShootingProjectSelection,
  undoShootingProjectSelection,
} from "@/services/shooting-projects";
import {
  createShootingProjectSchema,
  inspectShootingProjectSourceSchema,
  listShootingProjectsSchema,
  openShootingProjectSchema,
  projectAddLibrarySchema,
  projectArchiveSchema,
  projectBrowseSchema,
  projectCommitRelinkSchema,
  projectCreateOutputSchema,
  projectIdSchema,
  projectLibrarySchema,
  projectOutputSchema,
  projectOutputTaskSchema,
  projectPhotosSchema,
  projectPrepareSchema,
  projectRelinkSchema,
  projectRenameSchema,
  projectRetryOutputSchema,
  projectSelectionSchema,
} from "./schemas";

async function runProjectOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (
      error instanceof ShootingProjectError ||
      error instanceof ShootingProjectOutputError ||
      error instanceof ShootingProjectLibraryError
    ) {
      throw new ORPCError(error.code, {
        status: error.code === "NOT_FOUND" ? 404 : 400,
      });
    }
    throw error;
  }
}

export const inspectSource = os
  .input(inspectShootingProjectSourceSchema)
  .handler(({ input }) =>
    runProjectOperation(() => inspectShootingProjectSource(input.sourceRoot))
  );

export const create = os
  .input(createShootingProjectSchema)
  .handler(({ input }) =>
    runProjectOperation(() => createShootingProject(input))
  );

export const list = os
  .input(listShootingProjectsSchema)
  .handler(({ input }) =>
    runProjectOperation(() => listShootingProjects(input))
  );

export const open = os
  .input(openShootingProjectSchema)
  .handler(({ input }) =>
    runProjectOperation(() => openShootingProject(input.id))
  );

export const workspace = os
  .input(projectIdSchema)
  .handler(({ input }) =>
    runProjectOperation(() => getShootingProjectWorkspace(input.projectId))
  );
export const prepare = os
  .input(projectPrepareSchema)
  .handler(({ input }) =>
    runProjectOperation(() => prepareShootingProject(input))
  );
export const prioritize = os
  .input(projectPhotosSchema)
  .handler(({ input }) =>
    runProjectOperation(() => prioritizeShootingProjectPreviews(input))
  );
export const select = os
  .input(projectSelectionSchema)
  .handler(({ input }) =>
    runProjectOperation(() => setShootingProjectSelection(input))
  );
export const undo = os
  .input(projectIdSchema)
  .handler(({ input }) =>
    runProjectOperation(() => undoShootingProjectSelection(input.projectId))
  );
export const saveBrowse = os
  .input(projectBrowseSchema)
  .handler(({ input }) =>
    runProjectOperation(() => saveShootingProjectBrowse(input))
  );
export const inspectRelink = os
  .input(projectRelinkSchema)
  .handler(({ input }) =>
    runProjectOperation(() => inspectShootingProjectRelink(input))
  );
export const commitRelink = os
  .input(projectCommitRelinkSchema)
  .handler(({ input }) =>
    runProjectOperation(async () => {
      await stopShootingProjectLibraryTasks(input.projectId);
      await stopShootingProjectOutputTasks(input.projectId);
      return commitShootingProjectRelink(input);
    })
  );
export const rename = os
  .input(projectRenameSchema)
  .handler(({ input }) =>
    runProjectOperation(() => renameShootingProject(input))
  );
export const archive = os
  .input(projectArchiveSchema)
  .handler(({ input }) =>
    runProjectOperation(() => archiveShootingProject(input))
  );
export const remove = os.input(projectIdSchema).handler(({ input }) =>
  runProjectOperation(async () => {
    await stopShootingProjectLibraryTasks(input.projectId);
    await stopShootingProjectOutputTasks(input.projectId);
    return deleteShootingProject(input.projectId);
  })
);
export const clearPreviews = os
  .input(projectIdSchema)
  .handler(({ input }) =>
    runProjectOperation(() => clearShootingProjectPreviews(input.projectId))
  );
export const inspectOutput = os
  .input(projectOutputSchema)
  .handler(({ input }) =>
    runProjectOperation(() => inspectShootingProjectOutput(input))
  );
export const createOutput = os
  .input(projectCreateOutputSchema)
  .handler(({ input }) =>
    runProjectOperation(() => createShootingProjectOutput(input))
  );
export const listOutputs = os
  .input(projectIdSchema)
  .handler(({ input }) =>
    runProjectOperation(() => listShootingProjectOutputs(input.projectId))
  );
export const retryOutput = os
  .input(projectRetryOutputSchema)
  .handler(({ input }) =>
    runProjectOperation(() => retryShootingProjectOutput(input))
  );
export const cancelOutput = os
  .input(projectOutputTaskSchema)
  .handler(({ input }) =>
    runProjectOperation(() => cancelShootingProjectOutput(input))
  );
export const openOutput = os
  .input(projectOutputTaskSchema)
  .handler(({ input }) =>
    runProjectOperation(async () => {
      const task = (await listShootingProjectOutputs(input.projectId)).find(
        (candidate) => candidate.id === input.taskId
      );
      if (!task) {
        throw new ShootingProjectOutputError("OUTPUT_NOT_FOUND");
      }
      return { opened: (await shell.openPath(task.targetRoot)).length === 0 };
    })
  );
export const inspectLibrary = os
  .input(projectLibrarySchema)
  .handler(({ input }) =>
    runProjectOperation(() => inspectShootingProjectLibrary(input))
  );
export const addToLibrary = os
  .input(projectAddLibrarySchema)
  .handler(({ input }) =>
    runProjectOperation(() => addShootingProjectToLibrary(input))
  );
