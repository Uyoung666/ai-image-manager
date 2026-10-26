import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useGalleryThumbnail } from "@/hooks/useGalleryThumbnail";
import type { ImageLoadResult } from "@/utils/image-scheduler";

const jobs = vi.hoisted(
  () =>
    [] as Array<{
      url: string;
      finish: (result: ImageLoadResult) => void;
      release: ReturnType<typeof vi.fn>;
    }>
);
vi.mock("@/utils/image-scheduler", () => ({
  isImageReady: () => false,
  getDecodedImageEdge: () => undefined,
  scheduleImage: (url: string) => {
    const release = vi.fn();
    return {
      release,
      promote: vi.fn(),
      promise: new Promise<ImageLoadResult>((finish) =>
        jobs.push({ url, finish, release })
      ),
    };
  },
}));
vi.mock("@/utils/local-media-url", () => ({
  toGalleryThumbnailUrl: (
    id: number,
    edge: number,
    _version: string,
    source: string,
    _select: boolean,
    repair: boolean
  ) => `http://gallery/${id}/${edge}/${source}${repair ? "?repair=1" : ""}`,
}));
const media = new Set<EventTarget>();
function Fixture({
  id = 1,
  layoutWidth,
  layoutHeight,
  requestImage = true,
}: {
  id?: number;
  layoutWidth?: number;
  layoutHeight?: number;
  requestImage?: boolean;
}) {
  const image = useGalleryThumbnail({
    id,
    version: `photo-${id}`,
    sourceVersion: "identity",
    width: 300,
    height: 500,
    enabled: true,
    layoutWidth,
    layoutHeight,
    requestImage,
    visible: layoutWidth ? true : undefined,
  });
  return (
    <div ref={image.ref}>
      <output data-testid="resource">{image.url}</output>
    </div>
  );
}
beforeEach(() => {
  jobs.length = 0;
  media.clear();
  vi.stubGlobal("devicePixelRatio", 1);
  vi.stubGlobal("matchMedia", () => {
    const target = new EventTarget();
    media.add(target);
    return target;
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {
        /* Geometry is supplied by the fixture's fallback dimensions. */
      }
      disconnect() {
        /* No native observer is allocated. */
      }
    }
  );
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {
        /* Visibility is measured synchronously by the hook. */
      }
      disconnect() {
        /* No native observer is allocated. */
      }
    }
  );
});
afterEach(() => vi.unstubAllGlobals());
describe("gallery thumbnail handoff", () => {
  it("keeps an adequate decoded image when shrinking, and cancels an offscreen upgrade", async () => {
    const { rerender } = render(
      <Fixture layoutHeight={480} layoutWidth={320} />
    );
    await waitFor(() => expect(jobs).toHaveLength(1));
    await act(async () => jobs[0].finish("loaded"));
    rerender(<Fixture layoutHeight={210} layoutWidth={140} />);
    await act(async () => undefined);
    expect(jobs).toHaveLength(1);
    expect(screen.getByTestId("resource").textContent).toContain("/512/");
    rerender(<Fixture layoutHeight={1050} layoutWidth={700} />);
    await waitFor(() => expect(jobs).toHaveLength(2));
    expect(jobs[1].url).toContain("/2048/");
    rerender(
      <Fixture layoutHeight={1050} layoutWidth={700} requestImage={false} />
    );
    expect(jobs[1].release).toHaveBeenCalled();
    await act(async () => jobs[1].finish("loaded"));
    expect(screen.getByTestId("resource").textContent).toContain("/512/");
  });
  it("preserves the decoded smaller resource through a failed DPI upgrade and replaces only a successful upgrade", async () => {
    render(<Fixture />);
    await waitFor(() => expect(jobs).toHaveLength(1));
    expect(jobs[0].url).toContain("/512/");
    await act(async () => jobs[0].finish("loaded"));
    expect(screen.getByTestId("resource").textContent).toContain("/512/");
    act(() => {
      vi.stubGlobal("devicePixelRatio", 2);
      for (const target of [...media]) {
        target.dispatchEvent(new Event("change"));
      }
    });
    await waitFor(() => expect(jobs).toHaveLength(2));
    expect(jobs[1].url).toContain("/1024/");
    expect(screen.getByTestId("resource").textContent).toContain("/512/");
    await act(async () => jobs[1].finish("failed"));
    expect(screen.getByTestId("resource").textContent).toContain("/512/");
    await waitFor(() => expect(jobs).toHaveLength(3));
    expect(jobs[2].url).toContain("/1024/identity?repair=1");
    await act(async () => jobs[2].finish("failed"));
    expect(jobs).toHaveLength(3);
    expect(screen.getByTestId("resource").textContent).toContain("/512/");
    act(() => {
      vi.stubGlobal("devicePixelRatio", 3);
      for (const target of [...media]) {
        target.dispatchEvent(new Event("change"));
      }
    });
    await waitFor(() => expect(jobs).toHaveLength(4));
    await act(async () => jobs[3].finish("loaded"));
    expect(screen.getByTestId("resource").textContent).toContain("/2048/");
  });
  it("repairs a failed exact resource with a known source identity only once", async () => {
    render(<Fixture layoutHeight={210} layoutWidth={140} />);
    await waitFor(() => expect(jobs).toHaveLength(1));
    expect(jobs[0].url).toBe("http://gallery/1/256/identity");
    await act(async () => jobs[0].finish("failed"));
    await waitFor(() => expect(jobs).toHaveLength(2));
    expect(jobs[1].url).toBe("http://gallery/1/256/identity?repair=1");
    await act(async () => jobs[1].finish("loaded"));
    expect(screen.getByTestId("resource").textContent).toBe(jobs[1].url);
    expect(jobs).toHaveLength(2);
  });
  it("releases the previous generation and ignores its late successful response", async () => {
    const { rerender, unmount } = render(<Fixture />);
    await waitFor(() => expect(jobs).toHaveLength(1));
    rerender(<Fixture id={2} />);
    await waitFor(() => expect(jobs).toHaveLength(2));
    expect(jobs[0].release).toHaveBeenCalled();
    await act(async () => jobs[0].finish("loaded"));
    expect(screen.getByTestId("resource").textContent).toBe("");
    await act(async () => jobs[1].finish("loaded"));
    expect(screen.getByTestId("resource").textContent).toContain("gallery/2/");
    unmount();
    expect(jobs[1].release).toHaveBeenCalled();
  });
});
