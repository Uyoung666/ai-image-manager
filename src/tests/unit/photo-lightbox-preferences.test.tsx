import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LIGHTBOX_PANEL_MODE_STORAGE_KEY,
  readLightboxPanelMode,
  saveLightboxPanelMode,
} from "@/actions/lightbox-panel-preferences";
import { PhotoLightbox } from "@/components/PhotoLightbox";

const mocks = vi.hoisted(() => ({
  getPhotoExif: vi.fn(),
  getPhotoTags: vi.fn(),
  openInExplorer: vi.fn(),
}));

vi.mock("@/actions/wander", () => ({
  wanderActions: {
    recordExposure: vi.fn().mockResolvedValue({ ok: true }),
  },
}));

vi.mock("@/ipc/manager", () => ({
  ipc: {
    client: {
      photos: {
        getPhotoExif: mocks.getPhotoExif,
        getPhotoTags: mocks.getPhotoTags,
      },
      shell: {
        openInExplorer: mocks.openInExplorer,
      },
    },
  },
}));

vi.mock("@/utils/local-media-url", () => ({
  preloadImage: vi.fn(),
  toLocalMediaUrl: (filePath: string | null | undefined) =>
    filePath ? `local-media://${filePath}` : "",
}));

const photos = [
  {
    fileDate: new Date("2024-01-01").getTime(),
    filename: "first.jpg",
    fileSize: 1024,
    height: 3000,
    id: 1,
    path: "C:/Photos/first.jpg",
    thumbnailPath: "C:/Thumbs/first.jpg",
    width: 4000,
  },
  {
    fileDate: new Date("2024-01-02").getTime(),
    filename: "second.jpg",
    fileSize: 2048,
    height: 4000,
    id: 2,
    path: "C:/Photos/second.jpg",
    thumbnailPath: "C:/Thumbs/second.jpg",
    width: 3000,
  },
];

function renderLightbox(
  props: Partial<React.ComponentProps<typeof PhotoLightbox>> = {}
) {
  return render(
    <PhotoLightbox
      initialIndex={0}
      onClose={vi.fn()}
      open
      photos={photos}
      {...props}
    />
  );
}

describe("PhotoLightbox panel preferences", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mocks.getPhotoExif.mockResolvedValue({
      aperture: 2.8,
      cameraMake: "Sony",
      cameraModel: "A7",
      dateTaken: new Date("2024-01-01").getTime(),
      focalLength: "35",
      gpsLatitude: null,
      gpsLongitude: null,
      iso: 100,
      lensMake: null,
      lensModel: "FE 35mm",
      shutterSpeed: "1/250",
      software: null,
    });
    mocks.getPhotoTags.mockResolvedValue([]);
    mocks.openInExplorer.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("restores the ordinary lightbox info panel preference on reopen", () => {
    saveLightboxPanelMode("info");
    const { rerender } = renderLightbox();

    expect(
      screen.getByRole("complementary", { name: "照片详情" })
    ).toBeInTheDocument();

    rerender(
      <PhotoLightbox
        initialIndex={0}
        onClose={vi.fn()}
        open={false}
        photos={photos}
      />
    );
    rerender(
      <PhotoLightbox initialIndex={0} onClose={vi.fn()} open photos={photos} />
    );

    expect(
      screen.getByRole("complementary", { name: "照片详情" })
    ).toBeInTheDocument();
  });

  it("restores thumbnails and keeps panel modes mutually exclusive", () => {
    saveLightboxPanelMode("thumbnails");
    renderLightbox();

    expect(
      screen.getByRole("button", { name: "2: second.jpg" })
    ).toBeInTheDocument();
    expect(localStorage.getItem(LIGHTBOX_PANEL_MODE_STORAGE_KEY)).toBe(
      "thumbnails"
    );

    fireEvent.keyDown(window, { key: "i" });
    expect(
      screen.getByRole("complementary", { name: "照片详情" })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "2: second.jpg" })
    ).not.toBeInTheDocument();
    expect(localStorage.getItem(LIGHTBOX_PANEL_MODE_STORAGE_KEY)).toBe("info");

    fireEvent.keyDown(window, { key: "i" });
    expect(
      screen.queryByRole("complementary", { name: "照片详情" })
    ).not.toBeInTheDocument();
    expect(localStorage.getItem(LIGHTBOX_PANEL_MODE_STORAGE_KEY)).toBe("off");
  });

  it("keeps a saved thumbnails preference while hiding the strip for a single photo", async () => {
    saveLightboxPanelMode("thumbnails");
    const singlePhoto = [photos[0]];
    const { rerender } = renderLightbox({ photos: singlePhoto });

    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "1: first.jpg" })
      ).not.toBeInTheDocument()
    );
    expect(readLightboxPanelMode()).toBe("thumbnails");

    rerender(
      <PhotoLightbox
        initialIndex={0}
        onClose={vi.fn()}
        open={false}
        photos={singlePhoto}
      />
    );
    rerender(
      <PhotoLightbox
        initialIndex={0}
        onClose={vi.fn()}
        open
        photos={singlePhoto}
      />
    );

    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "1: first.jpg" })
      ).not.toBeInTheDocument()
    );
    expect(readLightboxPanelMode()).toBe("thumbnails");
  });

  it("saves off when the user closes the info panel with Escape", () => {
    saveLightboxPanelMode("info");
    const { rerender } = renderLightbox();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(
      screen.queryByRole("complementary", { name: "照片详情" })
    ).not.toBeInTheDocument();
    expect(localStorage.getItem(LIGHTBOX_PANEL_MODE_STORAGE_KEY)).toBe("off");

    rerender(
      <PhotoLightbox
        initialIndex={0}
        onClose={vi.fn()}
        open={false}
        photos={photos}
      />
    );
    rerender(
      <PhotoLightbox initialIndex={0} onClose={vi.fn()} open photos={photos} />
    );

    expect(
      screen.queryByRole("complementary", { name: "照片详情" })
    ).not.toBeInTheDocument();
  });

  it("saves off when the user closes the info panel from its close button", () => {
    saveLightboxPanelMode("info");
    renderLightbox();

    const panel = screen.getByRole("complementary", { name: "照片详情" });
    fireEvent.click(within(panel).getByRole("button", { name: "关闭" }));

    expect(
      screen.queryByRole("complementary", { name: "照片详情" })
    ).not.toBeInTheDocument();
    expect(localStorage.getItem(LIGHTBOX_PANEL_MODE_STORAGE_KEY)).toBe("off");
  });

  it("keeps the current frame when the open photo list grows", () => {
    const { rerender } = renderLightbox();

    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(screen.getByText("2 / 2")).toBeInTheDocument();

    const extendedPhotos = [
      ...photos,
      {
        fileDate: new Date("2024-01-03").getTime(),
        filename: "third.jpg",
        fileSize: 3072,
        height: 3000,
        id: 3,
        path: "C:/Photos/third.jpg",
        thumbnailPath: "C:/Thumbs/third.jpg",
        width: 4000,
      },
    ];
    rerender(
      <PhotoLightbox
        initialIndex={0}
        onClose={vi.fn()}
        open
        photos={extendedPhotos}
      />
    );

    expect(screen.getByText("2 / 3")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "second.jpg" })).toBeInTheDocument();
  });

  it("lets explicit sequence and autoplay modes override saved panels", () => {
    saveLightboxPanelMode("info");
    const { rerender } = renderLightbox({
      autoPlay: true,
      sequencePlayback: true,
      showThumbnailsInitially: true,
    });

    expect(
      screen.queryByRole("complementary", { name: "照片详情" })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "2: second.jpg" })
    ).toBeInTheDocument();
    expect(localStorage.getItem(LIGHTBOX_PANEL_MODE_STORAGE_KEY)).toBe("info");

    rerender(
      <PhotoLightbox
        autoPlay
        initialIndex={0}
        onClose={vi.fn()}
        open
        photos={photos}
      />
    );
    expect(
      screen.queryByRole("complementary", { name: "照片详情" })
    ).not.toBeInTheDocument();
    expect(readLightboxPanelMode()).toBe("info");
  });

  it("keeps panel interactions working when preference storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage unavailable");
    });

    renderLightbox();
    fireEvent.keyDown(window, { key: "i" });

    expect(
      screen.getByRole("complementary", { name: "照片详情" })
    ).toBeInTheDocument();
  });
});
