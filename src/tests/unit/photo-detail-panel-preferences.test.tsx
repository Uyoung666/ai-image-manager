import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PHOTO_DETAIL_ADVANCED_METADATA_STORAGE_KEY,
  savePhotoDetailAdvancedMetadataExpanded,
} from "@/actions/photo-detail-panel-preferences";
import { PhotoDetailPanel } from "@/components/PhotoDetailPanel";

const mocks = vi.hoisted(() => ({
  getPhotoExif: vi.fn(),
  getPhotoTagAnalysisStatus: vi.fn(),
  getPhotoTags: vi.fn(),
  getTags: vi.fn(),
}));

vi.mock("@/ipc/manager", () => ({
  ipc: {
    client: {
      photos: {
        getPhotoExif: mocks.getPhotoExif,
        getPhotoTagAnalysisStatus: mocks.getPhotoTagAnalysisStatus,
        getPhotoTags: mocks.getPhotoTags,
        getTags: mocks.getTags,
      },
    },
  },
}));

const photo = {
  fileSize: 1024,
  filename: "first.jpg",
  height: 3000,
  id: 1,
  path: "C:/Photos/first.jpg",
  thumbnailPath: "C:/Thumbs/first.webp",
  width: 4000,
};

function renderPanel() {
  return render(
    <PhotoDetailPanel
      onClose={vi.fn()}
      onOpenExplorer={vi.fn()}
      photo={photo}
    />
  );
}

describe("PhotoDetailPanel advanced metadata preference", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mocks.getPhotoExif.mockResolvedValue({
      advanced: {
        autofocus: {},
        capture: { exposureTime: "1/250" },
        processing: {},
        provenance: {},
        standard: {},
        vendor: null,
        vendorRaw: {},
        workflow: {},
      },
      aperture: 2.8,
      cameraMake: "Sony",
      cameraModel: "A7",
      dateTaken: null,
      focalLength: "35",
      gpsLatitude: null,
      gpsLongitude: null,
      iso: 100,
      lensMake: null,
      lensModel: "FE 35mm",
      orientation: null,
      shutterSpeed: "1/250",
      software: null,
    });
    mocks.getPhotoTagAnalysisStatus.mockResolvedValue({ state: "ready" });
    mocks.getPhotoTags.mockResolvedValue([]);
    mocks.getTags.mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows basic capture information and keeps advanced metadata collapsed by default", async () => {
    renderPanel();

    const summary = await screen.findByText("advancedMetadata");
    const details = summary.closest("details");

    expect(screen.getByText("Sony A7")).toBeInTheDocument();
    expect(details).not.toBeNull();
    expect((details as HTMLDetailsElement).open).toBe(false);
  });

  it("remembers the user's expanded or collapsed choice across panel remounts", async () => {
    const firstRender = renderPanel();
    const summary = await screen.findByText("advancedMetadata");
    const details = summary.closest("details") as HTMLDetailsElement;

    fireEvent.click(summary);
    await waitFor(() => expect(details.open).toBe(true));
    expect(
      localStorage.getItem(PHOTO_DETAIL_ADVANCED_METADATA_STORAGE_KEY)
    ).toBe("true");

    firstRender.unmount();
    renderPanel();
    const reopenedSummary = await screen.findByText("advancedMetadata");
    const reopenedDetails = reopenedSummary.closest(
      "details"
    ) as HTMLDetailsElement;
    expect(reopenedDetails.open).toBe(true);

    fireEvent.click(reopenedSummary);
    await waitFor(() => expect(reopenedDetails.open).toBe(false));
    expect(
      localStorage.getItem(PHOTO_DETAIL_ADVANCED_METADATA_STORAGE_KEY)
    ).toBe("false");
  });

  it("keeps the panel interactive when preference storage is unavailable", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage unavailable");
    });

    renderPanel();
    const summary = await screen.findByText("advancedMetadata");
    const details = summary.closest("details") as HTMLDetailsElement;

    fireEvent.click(summary);
    await waitFor(() => expect(details.open).toBe(true));
    expect(
      localStorage.getItem(PHOTO_DETAIL_ADVANCED_METADATA_STORAGE_KEY)
    ).toBeNull();
    expect(savePhotoDetailAdvancedMetadataExpanded(true)).toBe(false);
  });
});
