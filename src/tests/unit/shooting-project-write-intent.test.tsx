import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useShootingProjectWorkspace } from "@/hooks/use-shooting-project-workspace";
import type {
  ShootingProjectBrowseState,
  ShootingProjectPhoto,
  ShootingProjectPhotoStatus,
  ShootingProjectWorkspaceData,
} from "@/types/shooting-project";

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  workspace: vi.fn(),
  saveBrowse: vi.fn(),
  select: vi.fn(),
}));
vi.mock("@/actions/shooting-projects", () => ({
  shootingProjectActions: mocks,
}));

const PHOTO: ShootingProjectPhoto = {
  id: "a",
  projectId: "project",
  filename: "a.jpg",
  relativePath: "a.jpg",
  format: "jpg",
  fileSize: 1,
  modifiedAt: 1,
  dateTaken: null,
  width: 100,
  height: 100,
  status: "pending",
  sourceStatus: "available",
  previewStatus: "ready",
  previewWidth: 100,
  previewHeight: 100,
  previewError: null,
};
const DATA: ShootingProjectWorkspaceData = {
  project: {
    workflow: "curate",
    id: "project",
    name: "Shoot",
    sourceRoot: "D:\\source",
    sourceStatus: "online",
    sourceCheckedAt: 1,
    sourceInLibrary: false,
    createdAt: 1,
    updatedAt: 1,
    lastOpenedAt: 1,
    archivedAt: null,
    photoCount: 3,
    keptCount: 0,
    previewReadyCount: 3,
  },
  photos: [PHOTO, { ...PHOTO, id: "b" }, { ...PHOTO, id: "c" }],
  browsing: {
    currentPhotoId: "a",
    orderedPhotoIds: ["a", "b", "c"],
    filter: "all",
    format: "",
    sort: "time",
    view: "single",
    gridScrollTop: 0,
  },
  scan: { status: "completed", kind: "initial", discovered: 3, errors: [] },
  counts: {
    pending: 3,
    undecided: 0,
    kept: 0,
    rejected: 0,
    reviewed: 0,
    decided: 0,
    allDecided: false,
  },
  canUndo: false,
  previewBytes: 3,
};
let stored: ShootingProjectWorkspaceData;
let browseFailures: number;
let selectionFailures: number;

beforeEach(() => {
  vi.resetAllMocks();
  stored = structuredClone(DATA);
  browseFailures = 0;
  selectionFailures = 0;
  mocks.open.mockResolvedValue(DATA.project);
  mocks.workspace.mockImplementation(() =>
    Promise.resolve(structuredClone(stored))
  );
  mocks.saveBrowse.mockImplementation(
    ({ browsing }: { browsing: ShootingProjectBrowseState }) => {
      if (browseFailures > 0) {
        browseFailures -= 1;
        return Promise.reject(new Error("write failed"));
      }
      stored.browsing = structuredClone(browsing);
      return Promise.resolve({ saved: true });
    }
  );
  mocks.select.mockImplementation(
    ({
      photoIds,
      status,
    }: {
      photoIds: string[];
      status: ShootingProjectPhotoStatus;
    }) => {
      if (selectionFailures > 0) {
        selectionFailures -= 1;
        return Promise.reject(new Error("write failed"));
      }
      stored.photos = stored.photos.map((photo) =>
        photoIds.includes(photo.id) ? { ...photo, status } : photo
      );
      return Promise.resolve(structuredClone(stored));
    }
  );
});

it("leaves current-photo persistence to shared culling when legacy browse persistence is disabled", async () => {
  const { result, unmount } = renderHook(() =>
    useShootingProjectWorkspace("project", false)
  );
  await waitFor(() => expect(result.current.loading).toBe(false));
  // The backend may now point to a different pending photo selected by PK/curate.
  stored.browsing.currentPhotoId = "b";
  unmount();
  await act(async () => {
    await Promise.resolve();
  });
  expect(mocks.saveBrowse).not.toHaveBeenCalled();
});

async function mountWorkspace() {
  const view = renderHook(() => useShootingProjectWorkspace("project"));
  await waitFor(() => expect(view.result.current.data).not.toBeNull());
  return view;
}

describe("shooting project latest write intent", () => {
  it("does not restore failed position B after position C is saved, retried and reopened", async () => {
    browseFailures = 1;
    const view = await mountWorkspace();
    act(() =>
      view.result.current.updateBrowse({
        ...DATA.browsing,
        currentPhotoId: "b",
      })
    );
    await waitFor(() => expect(view.result.current.saveStatus).toBe("error"));
    expect(stored.browsing.currentPhotoId).toBe("a");
    act(() =>
      view.result.current.updateBrowse({
        ...DATA.browsing,
        currentPhotoId: "c",
      })
    );
    await waitFor(() => expect(stored.browsing.currentPhotoId).toBe("c"));
    await waitFor(() => expect(view.result.current.saveStatus).toBe("saved"));
    await act(async () => {
      await view.result.current.retry();
    });
    expect(
      mocks.saveBrowse.mock.calls.map(
        ([input]) => input.browsing.currentPhotoId
      )
    ).toEqual(["b", "c"]);
    view.unmount();
    const reopened = await mountWorkspace();
    expect(reopened.result.current.browsing?.currentPhotoId).toBe("c");
  });

  it("records a browse snapshot as persisted only after its write succeeds", async () => {
    browseFailures = 1;
    const view = await mountWorkspace();
    act(() =>
      view.result.current.updateBrowse({
        ...DATA.browsing,
        currentPhotoId: "b",
      })
    );
    await waitFor(() => expect(view.result.current.saveStatus).toBe("error"));
    // Reapplying the same intent must still save it after the previous attempt failed.
    act(() =>
      view.result.current.updateBrowse({
        ...DATA.browsing,
        currentPhotoId: "b",
      })
    );
    await waitFor(() => expect(stored.browsing.currentPhotoId).toBe("b"));
    expect(mocks.saveBrowse).toHaveBeenCalledTimes(2);
    expect(view.result.current.errorKey).toBeNull();
  });

  it("does not replay a failed keep after a later reject succeeds and the project reopens", async () => {
    selectionFailures = 1;
    const view = await mountWorkspace();
    await act(async () => {
      await view.result.current.select(["a"], "kept");
    });
    expect(view.result.current.saveStatus).toBe("error");
    await act(async () => {
      await view.result.current.select(["a"], "rejected");
    });
    expect(view.result.current.saveStatus).toBe("saved");
    await act(async () => {
      await view.result.current.retry();
    });
    expect(mocks.select.mock.calls.map(([input]) => input.status)).toEqual([
      "kept",
      "rejected",
    ]);
    view.unmount();
    const reopened = await mountWorkspace();
    expect(
      reopened.result.current.data?.photos.find((photo) => photo.id === "a")
        ?.status
    ).toBe("rejected");
  });

  it("retries only the unsuperseded members of a failed batch", async () => {
    selectionFailures = 1;
    const view = await mountWorkspace();
    await act(async () => {
      await view.result.current.select(["a", "b"], "kept");
    });
    await act(async () => {
      await view.result.current.select(["a"], "rejected");
    });
    expect(view.result.current.saveStatus).toBe("error");
    await act(async () => {
      await view.result.current.retry();
    });
    expect(mocks.select).toHaveBeenLastCalledWith({
      projectId: "project",
      photoIds: ["b"],
      status: "kept",
    });
    expect(
      stored.photos
        .filter((photo) => photo.id !== "c")
        .map((photo) => photo.status)
    ).toEqual(["rejected", "kept"]);
    view.unmount();
    const reopened = await mountWorkspace();
    expect(
      reopened.result.current.data?.photos
        .filter((photo) => photo.id !== "c")
        .map((photo) => photo.status)
    ).toEqual(["rejected", "kept"]);
  });
});
