import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PhotoLightbox } from "@/components/PhotoLightbox";
import { preloadImage } from "@/utils/local-media-url";

vi.mock("@/actions/wander", () => ({
  wanderActions: {
    recordExposure: vi.fn().mockResolvedValue({ ok: true }),
  },
}));

vi.mock("@/ipc/manager", () => ({
  ipc: {
    client: {
      photos: {
        getPhotoExif: vi.fn().mockResolvedValue({
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
        }),
        getPhotoTags: vi.fn().mockResolvedValue([]),
      },
      shell: {
        openInExplorer: vi.fn(),
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
    isFavorite: false,
    path: "C:/Photos/first.jpg",
    thumbnailPath: "C:/Thumbs/first.jpg",
    width: 4000,
  },
  {
    filename: "second.jpg",
    fileSize: 2048,
    height: 4000,
    id: 2,
    isFavorite: false,
    path: "C:/Photos/second.jpg",
    thumbnailPath: "C:/Thumbs/second.jpg",
    width: 3000,
  },
];

describe("PhotoLightbox", () => {
  it("keeps secondary review surfaces collapsed by default", () => {
    render(<PhotoLightbox initialIndex={0} onClose={vi.fn()} open photos={photos} />);

    expect(screen.getByRole("dialog", { name: "lightboxReview" })).toBeInTheDocument();
    expect(screen.getByText("1 / 2")).toBeInTheDocument();
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "2: second.jpg" })).not.toBeInTheDocument();
  });

  it("renders the reviewed image without a drop shadow", () => {
    render(<PhotoLightbox initialIndex={0} onClose={vi.fn()} open photos={photos} />);

    expect(screen.getByRole("img", { name: "first.jpg" })).not.toHaveClass(
      "shadow-2xl"
    );
  });

  it("makes the information panel and thumbnail strip mutually exclusive", async () => {
    render(
      <PhotoLightbox
        initialIndex={0}
        onClose={vi.fn()}
        open
        photos={photos}
      />
    );

    fireEvent.keyDown(window, { key: "t" });
    expect(screen.getByRole("button", { name: "2: second.jpg" })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "i" });
    expect(screen.queryByRole("button", { name: "2: second.jpg" })).not.toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "照片详情" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Sony A7")).toBeInTheDocument());
    expect(screen.getAllByRole("img", { name: "first.jpg" })).toHaveLength(1);
  });

  it("updates favorite optimistically and returns the final photo on close", async () => {
    const onToggleFavorite = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(
      <PhotoLightbox
        initialIndex={0}
        onClose={onClose}
        onToggleFavorite={onToggleFavorite}
        open
        photos={photos}
      />
    );

    fireEvent.keyDown(window, { key: "f" });
    await waitFor(() => expect(onToggleFavorite).toHaveBeenCalledWith(1, true));

    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(screen.getByText("2 / 2")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledWith({ index: 1, photoId: 2 });
  });

  it("handles a top toolbar action when the icon itself is clicked", async () => {
    const onToggleFavorite = vi.fn().mockResolvedValue(undefined);
    render(
      <PhotoLightbox
        initialIndex={0}
        onClose={vi.fn()}
        onToggleFavorite={onToggleFavorite}
        open
        photos={photos}
      />
    );

    const favoriteButton = screen.getByRole("button", { name: "favorite" });
    const favoriteIcon = favoriteButton.querySelector("svg");
    expect(favoriteIcon).not.toBeNull();
    fireEvent.click(favoriteIcon as SVGElement);

    await waitFor(() => expect(onToggleFavorite).toHaveBeenCalledWith(1, true));
  });

  it("coalesces wheel input into smooth proportional zoom updates", async () => {
    render(
      <PhotoLightbox
        initialIndex={0}
        onClose={vi.fn()}
        open
        photos={photos}
      />
    );

    const image = screen.getByRole("img", { name: "first.jpg" });
    fireEvent.wheel(image, { deltaMode: 0, deltaY: -100 });

    await waitFor(() => expect(screen.getByText("120%")).toBeInTheDocument());
    expect(image).toHaveStyle({ transition: "none" });
  });

  it("enters slideshow mode and pauses when the user navigates", () => {
    render(
      <PhotoLightbox
        initialIndex={0}
        onClose={vi.fn()}
        open
        photos={photos}
      />
    );

    fireEvent.keyDown(window, { key: " " });
    expect(screen.getByRole("button", { name: "pauseSlideshow" })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(screen.getByRole("button", { name: "playSlideshow" })).toBeInTheDocument();
  });

  it("renders a single thumbnail frame while playing a sequence", async () => {
    render(
      <PhotoLightbox
        autoPlay
        initialIndex={0}
        onClose={vi.fn()}
        open
        photos={photos}
        sequencePlayback
      />
    );

    const playbackFrame = await screen.findByRole("img", {
      name: "first.jpg",
    });
    expect(playbackFrame).toHaveAttribute(
      "data-lightbox-playback-frame",
      "true"
    );
    expect(playbackFrame).toHaveAttribute(
      "src",
      expect.stringContaining("Thumbs/first.jpg")
    );
    expect(document.querySelectorAll("[data-lightbox-image]")).toHaveLength(1);

    fireEvent.keyDown(window, { key: " " });

    expect(
      document.querySelector("[data-lightbox-playback-frame]")
    ).not.toBeInTheDocument();
    expect(screen.getByRole("img", { name: "first.jpg" })).toHaveAttribute(
      "src",
      expect.stringContaining("Photos/first.jpg")
    );
  });

  it("preloads wrapped playback frames before the sequence loops", async () => {
    vi.mocked(preloadImage).mockClear();
    render(
      <PhotoLightbox
        autoPlay
        initialIndex={1}
        onClose={vi.fn()}
        open
        photos={photos}
        sequencePlayback
      />
    );

    await waitFor(() =>
      expect(preloadImage).toHaveBeenCalledWith(photos[0].thumbnailPath)
    );
  });

  it("defers Escape handling while a child modal is open", () => {
    const onClose = vi.fn();
    render(
      <PhotoLightbox
        initialIndex={0}
        modalOpen
        onClose={onClose}
        open
        photos={photos}
      />
    );

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });
});
