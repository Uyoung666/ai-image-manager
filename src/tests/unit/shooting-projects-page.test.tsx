import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ShootingProjectCreateDialog } from "@/components/ShootingProjectCreateDialog";
import type {
  ShootingProject,
  ShootingProjectWorkspaceData,
} from "@/types/shooting-project";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  inspectSource: vi.fn(),
  list: vi.fn(),
  navigate: vi.fn(),
  open: vi.fn(),
  openFolderDialog: vi.fn(),
  workspace: vi.fn(),
  saveBrowse: vi.fn(),
  select: vi.fn(),
  undo: vi.fn(),
  prioritize: vi.fn(),
  listOutputs: vi.fn(),
  prepare: vi.fn(),
}));

vi.mock("@/actions/shooting-projects", () => ({
  shootingProjectActions: mocks,
}));
vi.mock("@/actions/shell", () => ({
  openFolderDialog: mocks.openFolderDialog,
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
}));
vi.mock("@/utils/shooting-project-media-url", () => ({
  toShootingProjectPreviewUrl: (_projectId: string, photoId: string) =>
    `/project-preview/${photoId}`,
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

const PROJECT: ShootingProject = {
  workflow: "curate",
  archivedAt: null,
  createdAt: 10,
  id: "project-1",
  keptCount: 0,
  lastOpenedAt: 20,
  name: "周末拍摄",
  photoCount: 0,
  previewReadyCount: 0,
  sourceCheckedAt: 20,
  sourceInLibrary: false,
  sourceRoot: "D:\\Shoot\\周末",
  sourceStatus: "online",
  updatedAt: 10,
};

const WORKSPACE: ShootingProjectWorkspaceData = {
  project: { ...PROJECT, photoCount: 1, previewReadyCount: 1 },
  photos: [
    {
      id: "photo-1",
      projectId: PROJECT.id,
      relativePath: "photo.jpg",
      filename: "photo.jpg",
      fileSize: 100,
      modifiedAt: 5,
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
    },
  ],
  browsing: {
    currentPhotoId: "photo-1",
    orderedPhotoIds: ["photo-1"],
    filter: "all",
    format: "",
    sort: "time",
    view: "single",
    gridScrollTop: 0,
  },
  scan: { status: "completed", kind: "initial", discovered: 1, errors: [] },
  counts: {
    pending: 1,
    undecided: 0,
    kept: 0,
    rejected: 0,
    reviewed: 0,
    decided: 0,
    allDecided: false,
  },
  previewBytes: 100,
  canUndo: false,
};

async function chooseSource() {
  fireEvent.click(screen.getByTestId("shooting-project-source-picker"));
  await waitFor(() =>
    expect(screen.getByTestId("shooting-project-name")).toHaveValue("周末拍摄")
  );
}

describe("shooting project pages", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.list.mockResolvedValue([]);
    mocks.open.mockResolvedValue(PROJECT);
    mocks.create.mockResolvedValue(PROJECT);
    mocks.workspace.mockResolvedValue(structuredClone(WORKSPACE));
    mocks.listOutputs.mockResolvedValue([]);
    mocks.prioritize.mockResolvedValue({ queued: 1 });
    mocks.saveBrowse.mockResolvedValue({ saved: true });
    mocks.prepare.mockResolvedValue(structuredClone(WORKSPACE));
    mocks.openFolderDialog.mockResolvedValue({ path: PROJECT.sourceRoot });
    mocks.inspectSource.mockResolvedValue({
      defaultName: PROJECT.name,
      sourceInLibrary: false,
      sourceRoot: PROJECT.sourceRoot,
      sourceStatus: "online",
    });
  });

  it.each([
    "curate",
    "duel",
    "hybrid",
  ] as const)("creates the selected %s workflow with curate selected by default", async (workflow) => {
    render(
      <ShootingProjectCreateDialog onClose={vi.fn()} onCreated={vi.fn()} />
    );
    await chooseSource();
    expect(screen.getByTestId("shooting-workflow-curate")).toBeChecked();
    fireEvent.click(screen.getByTestId(`shooting-workflow-${workflow}`));
    fireEvent.click(screen.getByTestId("shooting-project-create-submit"));
    await waitFor(() =>
      expect(mocks.create).toHaveBeenCalledWith(
        expect.objectContaining({ workflow })
      )
    );
  });

  it("requires explicit acknowledgement before creating from a library source", async () => {
    mocks.inspectSource.mockResolvedValue({
      defaultName: PROJECT.name,
      sourceInLibrary: true,
      sourceRoot: PROJECT.sourceRoot,
      sourceStatus: "online",
    });
    const onCreated = vi.fn();
    render(
      <ShootingProjectCreateDialog onClose={vi.fn()} onCreated={onCreated} />
    );
    await chooseSource();
    expect(
      screen.getByText("shootingProject.libraryWarning")
    ).toBeInTheDocument();
    expect(screen.getByTestId("shooting-project-create-submit")).toBeDisabled();
    expect(mocks.create).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByTestId("shooting-project-library-acknowledgement")
    );
    fireEvent.click(screen.getByTestId("shooting-project-create-submit"));
    await waitFor(() =>
      expect(mocks.create).toHaveBeenCalledWith(
        expect.objectContaining({ acknowledgeLibrarySource: true })
      )
    );
    expect(onCreated).toHaveBeenCalledWith(PROJECT);
  });

  it("keeps a failed save retryable without reporting success", async () => {
    mocks.create.mockRejectedValueOnce({ code: "SOURCE_UNAVAILABLE" });
    const onCreated = vi.fn();
    render(
      <ShootingProjectCreateDialog onClose={vi.fn()} onCreated={onCreated} />
    );
    await chooseSource();
    fireEvent.click(screen.getByTestId("shooting-project-create-submit"));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "shootingProject.sourceUnavailable"
    );
    expect(onCreated).not.toHaveBeenCalled();
    expect(screen.getByTestId("shooting-project-name")).toHaveValue(
      PROJECT.name
    );
    fireEvent.click(screen.getByTestId("shooting-project-create-submit"));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(PROJECT));
  });

  it("requests acknowledgement when the library relationship changed after inspection", async () => {
    mocks.create.mockRejectedValueOnce({
      code: "LIBRARY_CONFIRMATION_REQUIRED",
    });
    render(
      <ShootingProjectCreateDialog onClose={vi.fn()} onCreated={vi.fn()} />
    );
    await chooseSource();
    fireEvent.click(screen.getByTestId("shooting-project-create-submit"));
    await screen.findByText("shootingProject.libraryConfirmationRequired");
    expect(
      screen.getByTestId("shooting-project-library-acknowledgement")
    ).not.toBeChecked();
    expect(screen.getByTestId("shooting-project-create-submit")).toBeDisabled();
    fireEvent.click(
      screen.getByTestId("shooting-project-library-acknowledgement")
    );
    fireEvent.click(screen.getByTestId("shooting-project-create-submit"));
    await waitFor(() =>
      expect(mocks.create).toHaveBeenLastCalledWith(
        expect.objectContaining({ acknowledgeLibrarySource: true })
      )
    );
  });
});
