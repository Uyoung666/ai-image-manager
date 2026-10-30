import { ipc } from "@/ipc/manager";
import type {
  CreateShootingProjectInput,
  ShootingProject,
  ShootingProjectBrowseState,
  ShootingProjectLibraryRequest,
  ShootingProjectPhotoStatus,
  ShootingProjectSource,
} from "@/types/shooting-project";
import { trackCullWrite } from "@/utils/cull-write-state";

export const shootingProjectActions = {
  create(input: CreateShootingProjectInput): Promise<ShootingProject> {
    return ipc.client.shootingProjects.create(input);
  },
  inspectSource(sourceRoot: string): Promise<ShootingProjectSource> {
    return ipc.client.shootingProjects.inspectSource({ sourceRoot });
  },
  list(
    input: { archived?: boolean; search?: string } = {}
  ): Promise<ShootingProject[]> {
    return ipc.client.shootingProjects.list(input);
  },
  open(id: string): Promise<ShootingProject> {
    return ipc.client.shootingProjects.open({ id });
  },
  workspace(projectId: string) {
    return ipc.client.shootingProjects.workspace({ projectId });
  },
  prepare(input: {
    projectId: string;
    checkNew?: boolean;
    retryPreviews?: boolean;
  }) {
    return ipc.client.shootingProjects.prepare(input);
  },
  prioritize(input: { projectId: string; photoIds: string[] }) {
    return ipc.client.shootingProjects.prioritize(input);
  },
  select(input: {
    projectId: string;
    photoIds: string[];
    status: ShootingProjectPhotoStatus;
  }) {
    return trackCullWrite(input.projectId, () =>
      ipc.client.shootingProjects.select(input)
    );
  },
  undo(projectId: string) {
    return trackCullWrite(projectId, () =>
      ipc.client.shootingProjects.undo({ projectId })
    );
  },
  saveBrowse(input: {
    projectId: string;
    browsing: ShootingProjectBrowseState;
  }) {
    return ipc.client.shootingProjects.saveBrowse(input);
  },
  inspectRelink(input: { projectId: string; sourceRoot: string }) {
    return ipc.client.shootingProjects.inspectRelink(input);
  },
  commitRelink(input: {
    projectId: string;
    token: string;
    acceptCandidates: boolean;
  }) {
    return ipc.client.shootingProjects.commitRelink(input);
  },
  rename(input: { projectId: string; name: string }) {
    return ipc.client.shootingProjects.rename(input);
  },
  archive(input: { projectId: string; archived: boolean }) {
    return ipc.client.shootingProjects.archive(input);
  },
  delete(projectId: string) {
    return ipc.client.shootingProjects.remove({ projectId });
  },
  clearPreviews(projectId: string) {
    return ipc.client.shootingProjects.clearPreviews({ projectId });
  },
  inspectOutput(input: {
    projectId: string;
    targetParent: string;
    photoIds?: string[];
  }) {
    return ipc.client.shootingProjects.inspectOutput(input);
  },
  createOutput(input: {
    projectId: string;
    targetParent: string;
    photoIds?: string[];
    acknowledgeWatchedTarget?: boolean;
  }) {
    return ipc.client.shootingProjects.createOutput(input);
  },
  listOutputs(projectId: string) {
    return ipc.client.shootingProjects.listOutputs({ projectId });
  },
  retryOutput(input: {
    projectId: string;
    taskId: string;
    acknowledgeWatchedTarget?: boolean;
  }) {
    return ipc.client.shootingProjects.retryOutput(input);
  },
  cancelOutput(input: { projectId: string; taskId: string }) {
    return ipc.client.shootingProjects.cancelOutput(input);
  },
  openOutput(input: { projectId: string; taskId: string }) {
    return ipc.client.shootingProjects.openOutput(input);
  },
  inspectLibrary(input: ShootingProjectLibraryRequest) {
    return ipc.client.shootingProjects.inspectLibrary(input);
  },
  addToLibrary(
    input: ShootingProjectLibraryRequest & {
      confirmed: true;
      inspectionToken: string;
    }
  ) {
    return ipc.client.shootingProjects.addToLibrary(input);
  },
};
