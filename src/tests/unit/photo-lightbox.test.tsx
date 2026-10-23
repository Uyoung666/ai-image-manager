import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PhotoLightbox } from "@/components/PhotoLightbox";
import { preloadImage } from "@/utils/local-media-url";

const { toast } = vi.hoisted(() => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock("sonner", () => ({ toast }));

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
  toGalleryThumbnailUrl: () => "",
  preloadImage: vi.fn(),
  toLocalMediaUrl: (filePath: string | null | undefined) =>
    filePath ? `local-media://${filePath}` : "",
}));

const THUMBNAIL_NAME = /^\d+: image-/;
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

function renderSequence(sequencePhotos = photos) {
  return render(
    <PhotoLightbox
      autoPlay
      initialIndex={0}
      onClose={vi.fn()}
      open
      photos={sequencePhotos}
      sequencePlayback
    />
  );
}

function getFrame(selector: string) {
  const image = document.querySelector<HTMLImageElement>(selector);
  if (!image) {
    throw new Error(`Missing lightbox frame: ${selector}`);
  }
  return image;
}

async function loadImage(image: HTMLImageElement) {
  await act(async () => {
    fireEvent.load(image);
    await Promise.resolve();
  });
}

function firePointer(target: Element, type: string, options: PointerEventInit) {
  const event = new MouseEvent(type, { bubbles: true, ...options });
  Object.defineProperty(event, "pointerId", { value: options.pointerId });
  fireEvent(target, event);
}

function deferImageDecode(image: HTMLImageElement) {
  let resolveDecode: () => void = () => undefined;
  let rejectDecode: (error: Error) => void = () => undefined;
  const promise = new Promise<void>((resolve, reject) => {
    resolveDecode = resolve;
    rejectDecode = reject;
  });
  const decode = vi.fn().mockReturnValue(promise);
  Object.defineProperty(image, "decode", { configurable: true, value: decode });
  return { decode, rejectDecode, resolveDecode };
}

describe("PhotoLightbox", () => {
  it("keeps a 100k thumbnail strip bounded and opens directly near a deep current photo", () => {
    const many = Array.from({ length: 100_000 }, (_, index) => ({
      ...photos[0],
      id: index + 1,
      filename: `image-${index + 1}.jpg`,
    }));
    render(
      <PhotoLightbox
        initialIndex={99_990}
        onClose={vi.fn()}
        open
        photos={many}
        showThumbnailsInitially
      />
    );
    const thumbnails = screen.getAllByRole("button", { name: THUMBNAIL_NAME });
    expect(thumbnails.length).toBeLessThan(25);
    expect(
      screen.getByRole("button", { name: "99991: image-99991.jpg" })
    ).toBeInTheDocument();
  });
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    vi.useRealTimers();
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: undefined,
    });
  });

  it("traps keyboard focus and restores body state on close", () => {
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();
    document.body.style.overflow = "scroll";
    const { rerender } = render(
      <PhotoLightbox
        initialIndex={0}
        onClose={vi.fn()}
        onToggleFavorite={vi.fn().mockResolvedValue(undefined)}
        open
        photos={photos}
      />
    );

    expect(screen.getByRole("dialog")).toHaveAttribute("aria-modal", "true");
    expect(document.body.style.overflow).toBe("hidden");
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(
      screen
        .getByRole("dialog")
        .querySelector<HTMLElement>('[tabindex="0"], button:not([disabled])')
    );

    rerender(
      <PhotoLightbox
        initialIndex={0}
        onClose={vi.fn()}
        open={false}
        photos={photos}
      />
    );
    expect(document.body.style.overflow).toBe("scroll");
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it("preserves focus already restored to another gallery photo before modal cleanup", () => {
    render(
      <>
        <button type="button">Original photo</button>
        <button type="button">Returned photo</button>
      </>
    );
    screen.getByRole("button", { name: "Original photo" }).focus();
    const { rerender } = render(
      <PhotoLightbox initialIndex={0} onClose={vi.fn()} open photos={photos} />
    );
    const returned = screen.getByRole("button", { name: "Returned photo" });
    returned.focus();
    rerender(
      <PhotoLightbox
        initialIndex={0}
        onClose={vi.fn()}
        open={false}
        photos={photos}
      />
    );
    expect(document.activeElement).toBe(returned);
  });

  it("keeps secondary review surfaces collapsed by default", () => {
    render(
      <PhotoLightbox initialIndex={0} onClose={vi.fn()} open photos={photos} />
    );

    expect(
      screen.getByRole("dialog", { name: "lightboxReview" })
    ).toBeInTheDocument();
    expect(screen.getByText("1 / 2")).toBeInTheDocument();
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "2: second.jpg" })
    ).not.toBeInTheDocument();
  });

  it("renders the reviewed image without a drop shadow", () => {
    render(
      <PhotoLightbox initialIndex={0} onClose={vi.fn()} open photos={photos} />
    );

    expect(screen.getByRole("img", { name: "first.jpg" })).not.toHaveClass(
      "shadow-2xl"
    );
  });

  it("makes the information panel and thumbnail strip mutually exclusive", async () => {
    render(
      <PhotoLightbox initialIndex={0} onClose={vi.fn()} open photos={photos} />
    );

    fireEvent.keyDown(window, { key: "t" });
    expect(
      screen.getByRole("button", { name: "2: second.jpg" })
    ).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "i" });
    expect(
      screen.queryByRole("button", { name: "2: second.jpg" })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("complementary", { name: "照片详情" })
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText("Sony A7")).toBeInTheDocument()
    );
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

  it("reports copy success and failure from the more menu", async () => {
    const copyImageToClipboard = vi.fn().mockResolvedValue(true);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: { copyImageToClipboard },
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(
      <PhotoLightbox initialIndex={0} onClose={vi.fn()} open photos={photos} />
    );

    fireEvent.click(screen.getByRole("button", { name: "more" }));
    fireEvent.click(screen.getByRole("button", { name: "copyImage" }));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("imageCopiedToClipboard")
    );

    copyImageToClipboard.mockResolvedValueOnce(false);
    fireEvent.click(screen.getByRole("button", { name: "more" }));
    fireEvent.click(screen.getByRole("button", { name: "copyImage" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("copyFailed"));

    writeText.mockRejectedValueOnce(new Error("clipboard unavailable"));
    fireEvent.click(screen.getByRole("button", { name: "more" }));
    fireEvent.click(screen.getByRole("button", { name: "copyPath" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("copyFailed"));
  });

  it("coalesces wheel input into smooth proportional zoom updates", async () => {
    render(
      <PhotoLightbox initialIndex={0} onClose={vi.fn()} open photos={photos} />
    );

    const image = screen.getByRole("img", { name: "first.jpg" });
    fireEvent.wheel(image, { deltaMode: 0, deltaY: -100 });

    await waitFor(() => expect(screen.getByText("120%")).toBeInTheDocument());
    expect(image).toHaveStyle({ transition: "none" });
  });

  it("enters slideshow mode and pauses when the user navigates", () => {
    render(
      <PhotoLightbox initialIndex={0} onClose={vi.fn()} open photos={photos} />
    );

    fireEvent.keyDown(window, { key: " " });
    expect(
      screen.getByRole("button", { name: "pauseSlideshow" })
    ).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(
      screen.getByRole("button", { name: "playSlideshow" })
    ).toBeInTheDocument();
  });

  it("renders a single thumbnail frame while playing a sequence", async () => {
    renderSequence();

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
    expect(document.querySelectorAll("img")).toHaveLength(1);
    await loadImage(playbackFrame as HTMLImageElement);

    fireEvent.keyDown(window, { key: " " });

    expect(getFrame("[data-lightbox-playback-frame]")).toBe(playbackFrame);
    const originalFrame = getFrame("[data-lightbox-original-frame]");
    expect(originalFrame).toHaveAttribute("aria-hidden", "true");
    expect(originalFrame).toHaveClass("opacity-0");
    expect(screen.queryByLabelText("加载中…")).not.toBeInTheDocument();
    fireEvent.load(originalFrame);

    await waitFor(() =>
      expect(
        document.querySelector("[data-lightbox-playback-frame]")
      ).not.toBeInTheDocument()
    );
    expect(screen.getByRole("img", { name: "first.jpg" })).toHaveAttribute(
      "src",
      expect.stringContaining("Photos/first.jpg")
    );
  });

  it("freezes a loaded sequence frame immediately when paused with the button", async () => {
    vi.useFakeTimers();
    renderSequence();
    const playbackFrame = getFrame("[data-lightbox-playback-frame]");
    await loadImage(playbackFrame);

    fireEvent.click(screen.getByRole("button", { name: "pauseSlideshow" }));
    act(() => vi.advanceTimersByTime(600));

    expect(screen.getByText("1 / 2")).toBeInTheDocument();
    expect(getFrame("[data-lightbox-image]")).toBe(playbackFrame);
    expect(playbackFrame).not.toHaveClass("opacity-0");
    expect(screen.queryByLabelText("加载中…")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "playSlideshow" })
    ).toBeInTheDocument();
  });

  it("keeps the paused preview visible until original decoding finishes", async () => {
    renderSequence();
    const playbackFrame = getFrame("[data-lightbox-playback-frame]");
    await loadImage(playbackFrame);
    fireEvent.keyDown(window, { key: " " });
    const originalFrame = getFrame("[data-lightbox-original-frame]");
    const deferred = deferImageDecode(originalFrame);

    fireEvent.load(originalFrame);
    expect(deferred.decode).toHaveBeenCalledOnce();
    expect(getFrame("[data-lightbox-image]")).toBe(playbackFrame);
    expect(originalFrame).toHaveClass("opacity-0");
    expect(screen.queryByLabelText("加载中…")).not.toBeInTheDocument();

    await act(async () => deferred.resolveDecode());

    expect(getFrame("[data-lightbox-image]")).toBe(originalFrame);
    expect(originalFrame).toHaveClass("opacity-100");
    expect(originalFrame).not.toHaveAttribute("aria-hidden", "true");
    expect(playbackFrame).not.toBeInTheDocument();
  });

  it("ignores an older decode after playback resumes and is paused again", async () => {
    renderSequence();
    const playbackFrame = getFrame("[data-lightbox-playback-frame]");
    await loadImage(playbackFrame);
    fireEvent.keyDown(window, { key: " " });
    const oldOriginal = getFrame("[data-lightbox-original-frame]");
    const deferred = deferImageDecode(oldOriginal);
    fireEvent.load(oldOriginal);

    fireEvent.keyDown(window, { key: " " });
    expect(document.querySelectorAll("img")).toHaveLength(1);
    fireEvent.keyDown(window, { key: " " });
    const currentOriginal = getFrame("[data-lightbox-original-frame]");
    await act(async () => deferred.resolveDecode());
    fireEvent.error(oldOriginal);

    expect(currentOriginal).not.toBe(oldOriginal);
    expect(getFrame("[data-lightbox-image]")).toBe(playbackFrame);
    expect(
      screen.queryByText("imageOriginalLoadFailed")
    ).not.toBeInTheDocument();
    fireEvent.load(currentOriginal);
    await waitFor(() =>
      expect(getFrame("[data-lightbox-image]")).toBe(currentOriginal)
    );
  });

  it("does not carry a loaded preview or old original callbacks into the next photo", async () => {
    renderSequence();
    const oldPreview = getFrame("[data-lightbox-playback-frame]");
    await loadImage(oldPreview);
    fireEvent.keyDown(window, { key: " " });
    const oldOriginal = getFrame("[data-lightbox-original-frame]");
    const deferred = deferImageDecode(oldOriginal);
    fireEvent.load(oldOriginal);

    fireEvent.keyDown(window, { key: "ArrowRight" });
    const currentOriginal = getFrame("[data-lightbox-original-frame]");
    await act(async () => deferred.resolveDecode());
    fireEvent.error(oldOriginal);

    expect(screen.getByText("2 / 2")).toBeInTheDocument();
    expect(currentOriginal).toHaveAttribute(
      "src",
      expect.stringContaining("Photos/second.jpg")
    );
    expect(currentOriginal).toHaveClass("opacity-0");
    expect(oldPreview).not.toBeInTheDocument();
    const newPreview = document.querySelector("[data-lightbox-playback-frame]");
    if (newPreview) {
      expect(newPreview).toHaveAttribute(
        "src",
        expect.stringContaining("Thumbs/second.jpg")
      );
    }
    expect(screen.queryByText("imageLoadFailed")).not.toBeInTheDocument();
    fireEvent.load(currentOriginal);
    await waitFor(() => expect(currentOriginal).toHaveClass("opacity-100"));
  });

  it("invalidates original decoding when the viewer closes and opens again", async () => {
    const { rerender } = renderSequence();
    await loadImage(getFrame("[data-lightbox-playback-frame]"));
    fireEvent.keyDown(window, { key: " " });
    const oldOriginal = getFrame("[data-lightbox-original-frame]");
    const deferred = deferImageDecode(oldOriginal);
    fireEvent.load(oldOriginal);
    const props = {
      autoPlay: true,
      initialIndex: 0,
      onClose: vi.fn(),
      photos,
      sequencePlayback: true,
    };

    rerender(<PhotoLightbox {...props} open={false} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    rerender(<PhotoLightbox {...props} open />);
    const playbackFrame = getFrame("[data-lightbox-playback-frame]");
    await loadImage(playbackFrame);
    fireEvent.keyDown(window, { key: " " });
    const currentOriginal = getFrame("[data-lightbox-original-frame]");
    await act(async () => deferred.resolveDecode());
    fireEvent.error(oldOriginal);

    expect(getFrame("[data-lightbox-image]")).toBe(playbackFrame);
    expect(currentOriginal).toHaveClass("opacity-0");
    expect(
      screen.queryByText("imageOriginalLoadFailed")
    ).not.toBeInTheDocument();
    fireEvent.load(currentOriginal);
    await waitFor(() =>
      expect(getFrame("[data-lightbox-image]")).toBe(currentOriginal)
    );
  });

  it("keeps the preview available after original failure and retries the original", async () => {
    renderSequence();
    const playbackFrame = getFrame("[data-lightbox-playback-frame]");
    await loadImage(playbackFrame);
    fireEvent.keyDown(window, { key: " " });
    const failedOriginal = getFrame("[data-lightbox-original-frame]");
    fireEvent.error(failedOriginal);

    expect(getFrame("[data-lightbox-image]")).toBe(playbackFrame);
    expect(screen.getByText("imageOriginalLoadFailed")).toBeInTheDocument();
    expect(screen.queryByText("imageLoadFailed")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("加载中…")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "retry" }));
    const retriedOriginal = getFrame("[data-lightbox-original-frame]");
    expect(retriedOriginal).not.toBe(failedOriginal);
    expect(getFrame("[data-lightbox-image]")).toBe(playbackFrame);
    fireEvent.error(failedOriginal);
    expect(
      screen.queryByText("imageOriginalLoadFailed")
    ).not.toBeInTheDocument();
    fireEvent.load(retriedOriginal);
    await waitFor(() =>
      expect(getFrame("[data-lightbox-image]")).toBe(retriedOriginal)
    );
    expect(
      screen.queryByText("imageOriginalLoadFailed")
    ).not.toBeInTheDocument();
  });

  it("keeps the preview when original decoding fails", async () => {
    renderSequence();
    const playbackFrame = getFrame("[data-lightbox-playback-frame]");
    await loadImage(playbackFrame);
    fireEvent.keyDown(window, { key: " " });
    const originalFrame = getFrame("[data-lightbox-original-frame]");
    const deferred = deferImageDecode(originalFrame);
    fireEvent.load(originalFrame);

    await act(async () => deferred.rejectDecode(new Error("decode failed")));

    expect(getFrame("[data-lightbox-image]")).toBe(playbackFrame);
    expect(screen.getByText("imageOriginalLoadFailed")).toBeInTheDocument();
    expect(screen.queryByLabelText("加载中…")).not.toBeInTheDocument();
  });

  it("delays loading feedback for 200 ms without a thumbnail and retains the error panel", () => {
    vi.useFakeTimers();
    renderSequence(photos.map((photo) => ({ ...photo, thumbnailPath: "" })));
    fireEvent.keyDown(window, { key: " " });

    expect(screen.queryByLabelText("加载中…")).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(199));
    expect(screen.queryByLabelText("加载中…")).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByLabelText("加载中…")).toBeInTheDocument();
    fireEvent.error(getFrame("[data-lightbox-original-frame]"));
    expect(screen.getByText("imageLoadFailed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "retry" })).toBeInTheDocument();
    expect(screen.queryByLabelText("加载中…")).not.toBeInTheDocument();
  });

  it("promotes an already cached original without waiting for another load event", async () => {
    renderSequence();
    await loadImage(getFrame("[data-lightbox-playback-frame]"));
    vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(
      true
    );
    vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(
      4000
    );

    fireEvent.keyDown(window, { key: " " });

    await waitFor(() =>
      expect(
        document.querySelector("[data-lightbox-playback-frame]")
      ).not.toBeInTheDocument()
    );
    expect(getFrame("[data-lightbox-original-frame]")).toHaveClass(
      "opacity-100"
    );
    expect(screen.queryByLabelText("加载中…")).not.toBeInTheDocument();
  });

  it("shows the error panel for an already cached failed original without another error event", () => {
    vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(
      true
    );
    vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(
      0
    );

    render(
      <PhotoLightbox initialIndex={0} onClose={vi.fn()} open photos={photos} />
    );

    expect(screen.getByText("imageLoadFailed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "retry" })).toBeInTheDocument();
    expect(screen.queryByLabelText("加载中…")).not.toBeInTheDocument();
  });

  it("keeps a loaded preview when the original is already cached as failed", async () => {
    renderSequence();
    const playbackFrame = getFrame("[data-lightbox-playback-frame]");
    await loadImage(playbackFrame);
    vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(
      true
    );
    vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(
      0
    );

    fireEvent.keyDown(window, { key: " " });

    expect(getFrame("[data-lightbox-image]")).toBe(playbackFrame);
    expect(playbackFrame).toHaveClass("opacity-100");
    expect(screen.getByText("imageOriginalLoadFailed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "retry" })).toBeInTheDocument();
    expect(screen.queryByText("imageLoadFailed")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("加载中…")).not.toBeInTheDocument();
  });

  it("preserves zoom and rotation when replacing the paused preview", async () => {
    renderSequence();
    const playbackFrame = getFrame("[data-lightbox-playback-frame]");
    await loadImage(playbackFrame);
    fireEvent.keyDown(window, { key: " " });
    fireEvent.keyDown(window, { key: "+" });
    fireEvent.keyDown(window, { key: "r" });
    const originalFrame = getFrame("[data-lightbox-original-frame]");
    const transform = playbackFrame.style.transform;
    expect(transform).toContain("scale(1.2)");
    expect(transform).toContain("rotate(90deg)");
    expect(originalFrame).toHaveStyle({ transform });

    fireEvent.load(originalFrame);

    await waitFor(() => expect(playbackFrame).not.toBeInTheDocument());
    expect(getFrame("[data-lightbox-image]")).toHaveStyle({ transform });
  });

  it("continues dragging on the stable canvas after the original replaces the preview", async () => {
    renderSequence();
    const playbackFrame = getFrame("[data-lightbox-playback-frame]");
    await loadImage(playbackFrame);
    fireEvent.keyDown(window, { key: " " });
    fireEvent.keyDown(window, { key: "+" });
    const canvas = playbackFrame.parentElement as HTMLDivElement;
    const setPointerCapture = vi.fn();
    Object.defineProperty(canvas, "setPointerCapture", {
      configurable: true,
      value: setPointerCapture,
    });
    const originalFrame = getFrame("[data-lightbox-original-frame]");
    firePointer(playbackFrame, "pointerdown", {
      clientX: 100,
      clientY: 100,
      pointerId: 7,
    });
    expect(setPointerCapture).toHaveBeenCalledWith(7);
    firePointer(canvas, "pointermove", {
      clientX: 125,
      clientY: 140,
      pointerId: 7,
    });
    expect(playbackFrame.style.transform).toContain(
      "translate3d(25px, 40px, 0)"
    );
    const pausedTransform = playbackFrame.style.transform;

    await loadImage(originalFrame);

    expect(playbackFrame).not.toBeInTheDocument();
    expect(originalFrame.parentElement).toBe(canvas);
    expect(originalFrame).toHaveStyle({ transform: pausedTransform });
    firePointer(canvas, "pointermove", {
      clientX: 140,
      clientY: 160,
      pointerId: 7,
    });
    expect(originalFrame.style.transform).toContain(
      "translate3d(40px, 60px, 0)"
    );
    const draggedTransform = originalFrame.style.transform;
    firePointer(canvas, "pointermove", {
      clientX: 300,
      clientY: 300,
      pointerId: 8,
    });
    expect(originalFrame).toHaveStyle({ transform: draggedTransform });
    firePointer(canvas, "pointerup", { pointerId: 7 });
    firePointer(canvas, "pointermove", {
      clientX: 200,
      clientY: 200,
      pointerId: 7,
    });
    expect(originalFrame).toHaveStyle({ transform: draggedTransform });
  });

  it.each([
    "pointercancel",
    "lostpointercapture",
  ])("stops dragging when the canvas receives %s", async (cancelEvent) => {
    renderSequence();
    const playbackFrame = getFrame("[data-lightbox-playback-frame]");
    await loadImage(playbackFrame);
    fireEvent.keyDown(window, { key: " " });
    fireEvent.keyDown(window, { key: "+" });
    const canvas = playbackFrame.parentElement as HTMLDivElement;
    Object.defineProperty(canvas, "setPointerCapture", {
      configurable: true,
      value: vi.fn(),
    });
    firePointer(playbackFrame, "pointerdown", {
      clientX: 100,
      clientY: 100,
      pointerId: 7,
    });
    firePointer(canvas, "pointermove", {
      clientX: 120,
      clientY: 130,
      pointerId: 7,
    });
    const transform = playbackFrame.style.transform;
    firePointer(canvas, cancelEvent, { pointerId: 7 });
    firePointer(canvas, "pointermove", {
      clientX: 200,
      clientY: 200,
      pointerId: 7,
    });

    expect(playbackFrame).toHaveStyle({ transform });
  });

  it("uses original dimensions for actual pixels while the thumbnail is displayed", async () => {
    renderSequence();
    const playbackFrame = getFrame("[data-lightbox-playback-frame]");
    Object.defineProperties(playbackFrame, {
      clientWidth: { configurable: true, value: 1000 },
      naturalWidth: { configurable: true, value: 320 },
    });
    await loadImage(playbackFrame);
    fireEvent.keyDown(window, { key: " " });

    fireEvent.keyDown(window, { key: "1" });

    expect(playbackFrame.style.transform).toContain("scale(4)");
    expect(
      getFrame("[data-lightbox-original-frame]").style.transform
    ).toContain("scale(4)");
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
