import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ShootingProjectLibraryDialog } from "@/components/ShootingProjectLibraryDialog";
import { ShootingProjectManagement } from "@/components/ShootingProjectManagement";
import {
  ShootingProjectOutputDialog,
  ShootingProjectOutputs,
} from "@/components/ShootingProjectOutputs";
import { ShootingProjectRelinkDialog } from "@/components/ShootingProjectRelinkDialog";
import { ShootingProjectProgress } from "@/components/ShootingProjectWorkspace";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useShootingProjectOutputs } from "@/hooks/use-shooting-project-outputs";
import {
  mergeShootingProjectBrowse,
  sortShootingProjectPhotos,
} from "@/hooks/use-shooting-project-workspace";
import type {
  ShootingProjectOutputInspection,
  ShootingProjectOutputTask,
  ShootingProjectPhoto,
  ShootingProjectWorkspaceData,
} from "@/types/shooting-project";

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  workspace: vi.fn(),
  prioritize: vi.fn(),
  select: vi.fn(),
  undo: vi.fn(),
  saveBrowse: vi.fn(),
  inspectRelink: vi.fn(),
  commitRelink: vi.fn(),
  inspectOutput: vi.fn(),
  createOutput: vi.fn(),
  listOutputs: vi.fn(),
  retryOutput: vi.fn(),
  cancelOutput: vi.fn(),
  openOutput: vi.fn(),
  inspectLibrary: vi.fn(),
  addToLibrary: vi.fn(),
  delete: vi.fn(),
  clearPreviews: vi.fn(),
  archive: vi.fn(),
  rename: vi.fn(),
  openFolderDialog: vi.fn(),
  prepare: vi.fn(),
}));
vi.mock("@/actions/shooting-projects", () => ({
  shootingProjectActions: mocks,
}));
vi.mock("@/actions/shell", () => ({
  openFolderDialog: mocks.openFolderDialog,
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@/utils/shooting-project-media-url", () => ({
  toShootingProjectPreviewUrl: (_project: string, photo: string) =>
    `/project-preview/${photo}`,
}));
vi.mock("@/components/ZoomableImage", () => ({
  ZoomableImage: ({
    alt,
    previewUrl,
    previewOnly,
  }: {
    alt: string;
    previewUrl: string;
    previewOnly: boolean;
  }) => (
    <img
      alt={alt}
      data-preview-only={String(previewOnly)}
      height={120}
      src={previewUrl}
      width={160}
    />
  ),
}));
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: () => ({
    getTotalSize: () => 190,
    getVirtualItems: () => [{ key: "row-0", index: 0, start: 0, size: 190 }],
  }),
}));

const PHOTO: ShootingProjectPhoto = {
  id: "photo-a",
  projectId: "project-a",
  relativePath: "a.jpg",
  filename: "a.jpg",
  fileSize: 100,
  modifiedAt: 10,
  dateTaken: null,
  format: "jpg",
  width: 3000,
  height: 2000,
  status: "pending",
  sourceStatus: "available",
  previewStatus: "ready",
  previewWidth: 1200,
  previewHeight: 800,
  previewError: null,
};
const DATA: ShootingProjectWorkspaceData = {
  project: {
    workflow: "curate",
    id: "project-a",
    name: "Shoot",
    sourceRoot: "D:\\card",
    sourceStatus: "online",
    sourceCheckedAt: 1,
    sourceInLibrary: false,
    createdAt: 1,
    updatedAt: 1,
    lastOpenedAt: 1,
    archivedAt: null,
    photoCount: 2,
    keptCount: 0,
    previewReadyCount: 2,
  },
  photos: [
    PHOTO,
    {
      ...PHOTO,
      id: "photo-b",
      relativePath: "b.jpg",
      filename: "b.jpg",
      modifiedAt: 20,
    },
  ],
  browsing: {
    currentPhotoId: "photo-a",
    orderedPhotoIds: ["photo-a", "photo-b"],
    filter: "all",
    format: "",
    sort: "time",
    view: "single",
    gridScrollTop: 0,
  },
  scan: { status: "completed", kind: "initial", discovered: 2, errors: [] },
  counts: {
    pending: 2,
    undecided: 0,
    kept: 0,
    rejected: 0,
    reviewed: 0,
    decided: 0,
    allDecided: false,
  },
  previewBytes: 1024,
  canUndo: false,
};
const TASK: ShootingProjectOutputTask = {
  id: "task-a",
  projectId: "project-a",
  targetRoot: "D:\\editing\\Shoot",
  status: "completed",
  createdAt: 1,
  completedAt: 2,
  items: [
    {
      id: "item-a",
      photoId: "photo-a",
      relativePath: "a.jpg",
      sourcePath: "D:\\card\\a.jpg",
      targetPath: "D:\\editing\\Shoot\\a.jpg",
      kind: "original",
      fileSize: 100,
      copiedBytes: 100,
      status: "completed",
      error: null,
      sha256: "a".repeat(64),
    },
  ],
};
const OUTPUT_INSPECTION: ShootingProjectOutputInspection = {
  token: "receipt-output",
  targetRoot: TASK.targetRoot,
  originalCount: 2,
  acrCount: 0,
  xmpCount: 0,
  count: 2,
  unavailable: 0,
  bytes: 200,
  watched: false,
  ambiguities: [],
};

describe("offline preview preparation feedback", () => {
  it("shows ready state and the purpose when all previews already exist", () => {
    const run = vi.fn();
    render(
      <ShootingProjectProgress
        data={DATA}
        onRelink={vi.fn()}
        projectId="project-a"
        run={run}
        saving={false}
      />
    );
    const button = screen.getByTestId("shooting-prepare-previews");
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent("shootingProject.previewsReady");
    expect(screen.getByTestId("shooting-preview-help")).toHaveTextContent(
      "shootingProject.previewsHelp"
    );
    fireEvent.click(button);
    expect(run).not.toHaveBeenCalled();
  });

  it.each([
    "pending",
    "failed",
  ] as const)("prepares missing previews or retries %s work", async (status) => {
    const data = structuredClone(DATA);
    data.project.previewReadyCount = 1;
    data.photos[0].previewStatus = status;
    mocks.prepare.mockResolvedValue(DATA);
    const run = vi.fn((action: () => Promise<ShootingProjectWorkspaceData>) =>
      action()
    );
    render(
      <ShootingProjectProgress
        data={data}
        onRelink={vi.fn()}
        projectId="project-a"
        run={run}
        saving={false}
      />
    );
    const button = screen.getByTestId("shooting-prepare-previews");
    expect(button).toBeEnabled();
    expect(button).toHaveTextContent(
      status === "failed"
        ? "shootingProject.retryPreviews"
        : "shootingProject.preparePreviews"
    );
    fireEvent.click(button);
    await waitFor(() =>
      expect(mocks.prepare).toHaveBeenCalledWith({
        projectId: "project-a",
        retryPreviews: true,
      })
    );
  });

  it("explains an unreadable optional group and allows only skipping it", async () => {
    mocks.inspectOutput.mockResolvedValue({
      ...OUTPUT_INSPECTION,
      ambiguities: [
        {
          id: "pair-a",
          photos: [
            { relativePath: "pair.nef", selected: true },
            { relativePath: "pair.jpg", selected: false },
          ],
          files: [
            {
              relativePath: "pair.acr",
              kind: "acr",
              fileSize: 100,
              unavailable: true,
            },
          ],
        },
      ],
    });
    mocks.createOutput.mockResolvedValue(TASK);
    const created = vi.fn();
    render(
      <ShootingProjectOutputDialog
        onClose={vi.fn()}
        onCreated={created}
        projectId="project-a"
      />
    );
    fireEvent.click(screen.getByTestId("shooting-output-choose"));
    const unavailable = "shootingProject.outputSidecarUnavailable";
    expect(await screen.findByText(unavailable)).toBeVisible();
    expect(screen.getByRole("group")).toHaveAccessibleDescription(unavailable);
    expect(
      screen.getByRole("radio", {
        name: "shootingProject.outputIncludeSidecars",
      })
    ).toBeDisabled();
    const confirm = screen.getByTestId("shooting-output-confirm");
    expect(confirm).toBeDisabled();
    fireEvent.click(
      screen.getByRole("radio", {
        name: "shootingProject.outputSkipSidecars",
      })
    );
    fireEvent.click(confirm);
    await waitFor(() => expect(created).toHaveBeenCalledWith(TASK));
    expect(mocks.createOutput).toHaveBeenCalledWith(
      expect.objectContaining({ decisions: [{ id: "pair-a", action: "skip" }] })
    );
  });

  it.each([
    "scanning",
    "empty",
    "offline",
  ])("disables preparation while %s", (state) => {
    const data = structuredClone(DATA);
    if (state === "scanning") {
      data.scan.status = "running";
    }
    if (state === "empty") {
      data.photos = [];
      data.project.previewReadyCount = 0;
    }
    if (state === "offline") {
      data.project.sourceStatus = "offline";
      data.project.previewReadyCount = 0;
    }
    render(
      <ShootingProjectProgress
        data={data}
        onRelink={vi.fn()}
        projectId="project-a"
        run={vi.fn()}
        saving={false}
      />
    );
    expect(screen.getByTestId("shooting-prepare-previews")).toBeDisabled();
  });
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {
        /* Dimensions are controlled by the virtualizer fixture. */
      }
      disconnect() {
        /* No observers are registered by this fixture. */
      }
    }
  );
  mocks.open.mockResolvedValue(DATA.project);
  mocks.workspace.mockResolvedValue(structuredClone(DATA));
  mocks.listOutputs.mockResolvedValue([]);
  mocks.prioritize.mockResolvedValue({ queued: 2 });
  mocks.saveBrowse.mockResolvedValue({ saved: true });
  mocks.openFolderDialog.mockResolvedValue({ path: "D:\\editing" });
  mocks.openOutput.mockResolvedValue({ opened: true });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("shooting project browse compatibility", () => {
  it("preserves the established sequence when discoveries and metadata arrive", () => {
    const next = mergeShootingProjectBrowse(
      { ...DATA.browsing, currentPhotoId: "photo-b" },
      [
        { ...DATA.photos[1], dateTaken: 1 },
        { ...DATA.photos[0], dateTaken: 1000 },
        { ...PHOTO, id: "new", modifiedAt: 0 },
      ]
    );
    expect(next.orderedPhotoIds).toEqual(["photo-a", "photo-b", "new"]);
    expect(next.currentPhotoId).toBe("photo-b");
    expect(
      sortShootingProjectPhotos(
        [
          { ...PHOTO, dateTaken: 1000 },
          { ...PHOTO, id: "photo-b", dateTaken: 1 },
        ],
        "time"
      )
    ).toEqual(["photo-b", "photo-a"]);
  });
});

describe("shooting project confirmation boundaries", () => {
  it("requires lightweight candidate acceptance before committing a relink token", async () => {
    mocks.inspectRelink.mockResolvedValue({
      token: "receipt-r",
      sourceRoot: "D:\\editing",
      verified: 0,
      candidates: 1,
      missing: 1,
      changed: 0,
      insufficient: 0,
      items: [
        { photoId: "photo-a", relativePath: "a.jpg", status: "candidate" },
        { photoId: "photo-b", relativePath: "b.jpg", status: "missing" },
      ],
    });
    mocks.commitRelink.mockResolvedValue(DATA);
    const complete = vi.fn();
    render(
      <ShootingProjectRelinkDialog
        onClose={vi.fn()}
        onComplete={complete}
        projectId="project-a"
      />
    );
    fireEvent.click(screen.getByTestId("shooting-relink-choose"));
    await screen.findByText("shootingProject.relinkEvidence");
    expect(screen.getByTestId("shooting-relink-confirm")).toBeDisabled();
    expect(mocks.commitRelink).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("shooting-relink-accept"));
    fireEvent.click(screen.getByTestId("shooting-relink-confirm"));
    await waitFor(() =>
      expect(mocks.commitRelink).toHaveBeenCalledWith({
        projectId: "project-a",
        token: "receipt-r",
        acceptCandidates: true,
      })
    );
    expect(complete).toHaveBeenCalledWith(DATA);
  });

  it("blocks watched output until explicitly acknowledged and retains failed confirmation for retry", async () => {
    mocks.inspectOutput.mockResolvedValue({
      ...OUTPUT_INSPECTION,
      watched: true,
    });
    mocks.createOutput
      .mockRejectedValueOnce({ code: "OUTPUT_NO_SPACE" })
      .mockResolvedValue(TASK);
    const created = vi.fn();
    render(
      <ShootingProjectOutputDialog
        onClose={vi.fn()}
        onCreated={created}
        photoIds={["photo-a"]}
        projectId="project-a"
      />
    );
    fireEvent.click(screen.getByTestId("shooting-output-choose"));
    await screen.findByText("shootingProject.outputWatchWarning");
    expect(screen.getByTestId("shooting-output-confirm")).toBeDisabled();
    fireEvent.click(screen.getByTestId("shooting-output-watch-ack"));
    fireEvent.click(screen.getByTestId("shooting-output-confirm"));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("shootingProject.outputNoSpace");
    await waitFor(() => expect(alert).toHaveFocus());
    expect(created).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("shooting-output-confirm"));
    await waitFor(() => expect(created).toHaveBeenCalledWith(TASK));
    expect(mocks.createOutput).toHaveBeenLastCalledWith({
      projectId: "project-a",
      targetParent: "D:\\editing",
      photoIds: ["photo-a"],
      acknowledgeWatchedTarget: true,
      inspectionToken: OUTPUT_INSPECTION.token,
      decisions: [],
    });
  });

  it.each([
    ["OUTPUT_INSPECTION_CHANGED", "outputInspectionChanged"],
    ["OUTPUT_INSPECTION_EXPIRED", "outputInspectionExpired"],
  ])("refreshes %s in place and requires new decisions", async (code, key) => {
    const group = {
      id: "pair-a",
      photos: [
        { relativePath: "a.nef", selected: true },
        { relativePath: "a.jpg", selected: false },
      ],
      files: [
        { relativePath: "a.xmp", kind: "xmp", fileSize: 100 },
        { relativePath: "a.acr", kind: "acr", fileSize: 200 },
      ],
    };
    mocks.inspectOutput
      .mockResolvedValueOnce({ ...OUTPUT_INSPECTION, ambiguities: [group] })
      .mockResolvedValueOnce({
        ...OUTPUT_INSPECTION,
        ambiguities: [{ ...group, id: "refreshed-a" }],
        token: "new-output",
      });
    mocks.createOutput.mockRejectedValueOnce({ code }).mockResolvedValue(TASK);
    const created = vi.fn();
    render(
      <ShootingProjectOutputDialog
        onClose={vi.fn()}
        onCreated={created}
        projectId="project-a"
      />
    );
    fireEvent.click(screen.getByTestId("shooting-output-choose"));
    const confirm = screen.getByTestId("shooting-output-confirm");
    const include = { name: "shootingProject.outputIncludeSidecars" };
    fireEvent.click(await screen.findByRole("radio", include));
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(key);
    expect(alert).toHaveTextContent("shootingProject.outputReconfirmSidecars");
    await waitFor(() => expect(alert).toHaveFocus());
    expect(await screen.findByRole("radio", include)).not.toBeChecked();
    expect(confirm).toBeDisabled();
    expect(mocks.openFolderDialog).toHaveBeenCalledOnce();
    expect(mocks.inspectOutput).toHaveBeenCalledTimes(2);
    const skip = { name: "shootingProject.outputSkipSidecars" };
    fireEvent.click(screen.getByRole("radio", skip));
    fireEvent.click(confirm);
    await waitFor(() => expect(created).toHaveBeenCalledWith(TASK));
    expect(mocks.createOutput).toHaveBeenLastCalledWith({
      projectId: "project-a",
      photoIds: undefined,
      targetParent: "D:\\editing",
      inspectionToken: "new-output",
      decisions: [{ id: "refreshed-a", action: "skip" }],
      acknowledgeWatchedTarget: false,
    });
  });

  it("suggests completed outputs and confirms the exact library inspection receipt", async () => {
    mocks.inspectLibrary.mockResolvedValue({
      token: "receipt-l",
      count: 1,
      unavailable: 0,
      paths: [TASK.items[0].targetPath],
      photoIds: ["photo-a"],
    });
    mocks.addToLibrary.mockResolvedValue({ added: 1, failed: 0 });
    render(
      <ShootingProjectLibraryDialog
        onClose={vi.fn()}
        projectId="project-a"
        tasks={[TASK]}
      />
    );
    await screen.findByText(TASK.items[0].targetPath);
    expect(mocks.addToLibrary).not.toHaveBeenCalled();
    expect(mocks.inspectLibrary).toHaveBeenCalledWith({
      projectId: "project-a",
      source: "output",
      taskId: "task-a",
      photoIds: undefined,
    });
    fireEvent.click(screen.getByTestId("shooting-library-confirm"));
    await waitFor(() =>
      expect(mocks.addToLibrary).toHaveBeenCalledWith({
        projectId: "project-a",
        source: "output",
        taskId: "task-a",
        photoIds: ["photo-a"],
        confirmed: true,
        inspectionToken: "receipt-l",
      })
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "shootingProject.libraryResult"
    );
  });

  it.each([
    "OUTPUT_RECHECK_UNAVAILABLE",
    "OUTPUT_INCOMPLETE",
    "OUTPUT_CONFLICT",
    "OUTPUT_INVALID_TARGET",
    "OUTPUT_VERIFY_FAILED",
  ])("returns to refreshed copy tasks when the library inspection reports %s", async (code) => {
    mocks.listOutputs
      .mockResolvedValueOnce([TASK])
      .mockResolvedValue([{ ...TASK, status: "failed", completedAt: null }]);
    mocks.inspectLibrary.mockRejectedValue({ code });
    mocks.retryOutput.mockResolvedValue(TASK);
    render(
      <ShootingProjectOutputs
        keptCount={1}
        projectId="project-a"
        selectedIds={[]}
      />
    );
    const output = await screen.findByTestId("shooting-output-task");
    expect(output).toHaveAttribute("data-status", "completed");
    fireEvent.click(screen.getByTestId("shooting-add-library"));
    const returnButton = await screen.findByRole("button", {
      name: "shootingProject.outputReturnToTasks",
    });
    expect(screen.getByTestId("shooting-library-confirm")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "retry" })).toBeNull();
    fireEvent.click(returnButton);
    await waitFor(() =>
      expect(output).toHaveAttribute("data-status", "failed")
    );
    expect(mocks.inspectLibrary).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByTestId("shooting-output-retry"));
    await waitFor(() =>
      expect(mocks.retryOutput).toHaveBeenCalledWith({
        projectId: "project-a",
        taskId: TASK.id,
        acknowledgeWatchedTarget: false,
      })
    );
  });

  it("preserves a fixed interrupted task during retry and does not auto-open historical outputs", async () => {
    mocks.listOutputs.mockResolvedValue([
      TASK,
      { ...TASK, id: "interrupted", status: "interrupted" },
    ]);
    mocks.retryOutput.mockResolvedValue({
      ...TASK,
      id: "interrupted",
      status: "running",
    });
    render(
      <ShootingProjectOutputs
        keptCount={0}
        projectId="project-a"
        selectedIds={[]}
      />
    );
    await waitFor(() =>
      expect(screen.getAllByTestId("shooting-output-task")).toHaveLength(2)
    );
    expect(mocks.openOutput).not.toHaveBeenCalled();
    const retryButtons = screen.getAllByTestId("shooting-output-retry");
    fireEvent.click(retryButtons[1]);
    await waitFor(() =>
      expect(mocks.retryOutput).toHaveBeenCalledWith({
        projectId: "project-a",
        taskId: "interrupted",
        acknowledgeWatchedTarget: false,
      })
    );
    expect(mocks.createOutput).not.toHaveBeenCalled();
  });

  it("requires a delete confirmation that states the managed data boundary", async () => {
    mocks.delete.mockResolvedValue({ deleted: true });
    const deleted = vi.fn();
    render(
      <TooltipProvider>
        <ShootingProjectManagement
          onChanged={vi.fn()}
          onDeleted={deleted}
          onWorkspace={vi.fn()}
          previewBytes={1000}
          project={DATA.project}
        />
      </TooltipProvider>
    );
    fireEvent.click(screen.getByTestId("shooting-project-manage"));
    fireEvent.click(await screen.findByTestId("shooting-project-delete"));
    expect(
      screen.getByText("shootingProject.deleteDescription")
    ).toBeInTheDocument();
    expect(mocks.delete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("shooting-project-manage-confirm"));
    await waitFor(() => expect(mocks.delete).toHaveBeenCalledWith("project-a"));
    expect(deleted).toHaveBeenCalledOnce();
  });
});

it("tracks a newly created output outside the dialog and opens it once, including instant completion", async () => {
  mocks.listOutputs.mockResolvedValue([TASK]);
  const { result } = renderHook(() => useShootingProjectOutputs("project-a"));
  await waitFor(() => expect(result.current.tasks).toHaveLength(1));
  expect(mocks.openOutput).not.toHaveBeenCalled();
  act(() => result.current.updateTask({ ...TASK, status: "running" }, true));
  await act(async () => {
    await result.current.load();
  });
  await waitFor(() => expect(mocks.openOutput).toHaveBeenCalledTimes(1));
  await act(async () => {
    await result.current.load();
  });
  expect(mocks.openOutput).toHaveBeenCalledTimes(1);
  act(() => result.current.updateTask({ ...TASK, id: "instant" }, true));
  await waitFor(() => expect(mocks.openOutput).toHaveBeenCalledTimes(2));
});
