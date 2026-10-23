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
    source: string
  ) => `http://gallery/${id}/${edge}/${source}`,
}));
const media = new Set<EventTarget>();
function Fixture({ id = 1 }: { id?: number }) {
  const image = useGalleryThumbnail({
    id,
    version: `photo-${id}`,
    sourceVersion: "identity",
    width: 300,
    height: 500,
    enabled: true,
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
    act(() => {
      vi.stubGlobal("devicePixelRatio", 3);
      for (const target of [...media]) {
        target.dispatchEvent(new Event("change"));
      }
    });
    await waitFor(() => expect(jobs).toHaveLength(3));
    await act(async () => jobs[2].finish("loaded"));
    expect(screen.getByTestId("resource").textContent).toContain("/2048/");
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
