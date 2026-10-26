import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useGalleryThumbnail } from "@/hooks/useGalleryThumbnail";

const jobs = vi.hoisted(
  () =>
    [] as Array<{
      url: string;
      options: { priority: number; retainDecoded?: boolean };
      resolve: (value: string) => void;
      release: ReturnType<typeof vi.fn>;
    }>
);
const descriptorRequests = vi.hoisted(() => [] as string[]);
const descriptorJobs = vi.hoisted(
  () =>
    [] as Array<{
      resolve: (value: { thumbnailVersion: string }) => void;
      release: ReturnType<typeof vi.fn>;
    }>
);
const descriptorControl = vi.hoisted(() => ({ defer: false }));
const readyUrls = vi.hoisted(() => new Set<string>());
vi.mock("@/utils/gallery-thumbnail-descriptors", () => ({
  requestThumbnailVersion: (_id: number, options: { generation: string }) => {
    descriptorRequests.push(options.generation);
    const release = vi.fn();
    return {
      resource: new Promise<{ thumbnailVersion: string }>((resolve) => {
        descriptorJobs.push({ resolve, release });
        if (!descriptorControl.defer) {
          resolve({ thumbnailVersion: "source" });
        }
      }),
      promote: vi.fn(),
      release,
    };
  },
}));
vi.mock("@/utils/gallery-image-observer", () => ({
  getGalleryDpr: () => 1,
  subscribeGalleryDpr: () => () => undefined,
  observeGalleryImage: () => () => undefined,
}));
vi.mock("@/utils/local-media-url", () => ({
  toGalleryThumbnailUrl: (
    id: number,
    edge: number,
    version: string,
    _source: string,
    select: boolean,
    repair: boolean
  ) => {
    const query = [
      select ? "select=1" : "",
      repair ? "repair=1" : "",
      version === "test" ? "" : `v=${encodeURIComponent(version)}`,
    ]
      .filter(Boolean)
      .join("&");
    return `http://gallery/${id}/${edge}${query ? `?${query}` : ""}`;
  },
}));
vi.mock("@/utils/image-scheduler", () => ({
  isImageReady: (url: string) => readyUrls.has(url),
  getDecodedImageEdge: () => 1024,
  scheduleImage: (
    url: string,
    options: { priority: number; retainDecoded?: boolean }
  ) => {
    const release = vi.fn();
    return {
      release,
      promote: vi.fn(),
      promise: new Promise((resolve) =>
        jobs.push({ url, options, resolve, release })
      ),
    };
  },
}));
function Fixture({
  id = 20,
  idle = false,
  requestImage = true,
  sourceKey = "",
  visible = true,
  size = 140,
}: {
  id?: number;
  idle?: boolean;
  requestImage?: boolean;
  sourceKey?: string;
  visible?: boolean;
  size?: number;
}) {
  const image = useGalleryThumbnail({
    id,
    version: "test",
    sourceKey,
    width: 140,
    height: 210,
    layoutWidth: size,
    layoutHeight: size * 1.5,
    visible,
    enabled: true,
    idle,
    requestImage,
  });
  return (
    <div ref={image.ref}>
      <output data-failed={image.failed} data-testid="resource">
        {image.url}
      </output>
    </div>
  );
}
beforeEach(() => {
  jobs.length = 0;
  descriptorRequests.length = 0;
  descriptorJobs.length = 0;
  descriptorControl.defer = false;
  readyUrls.clear();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());
it("keeps the selected decoded larger URL when a prefetched card remounts in a smaller grid", async () => {
  const first = render(<Fixture size={320} visible={false} />);
  await act(async () => {
    await Promise.resolve();
  });
  const url = jobs[0].url;
  expect(url).toContain("/512?select=1");
  readyUrls.add(url);
  await act(async () => jobs[0].resolve("loaded"));
  first.unmount();
  render(<Fixture size={140} />);
  expect(screen.getByTestId("resource").textContent).toBe(url);
  expect(jobs[1].url).toBe(url);
});
it("starts visible selection without an IPC barrier and prepares the preferred tier only while idle", async () => {
  const { rerender } = render(<Fixture />);
  expect(jobs[0].url).toBe("http://gallery/20/256?select=1");
  expect(descriptorRequests).toHaveLength(0);
  await act(async () => jobs[0].resolve("loaded"));
  expect(screen.getByTestId("resource").textContent).toContain("?select=1");
  await act(async () => vi.advanceTimersByTimeAsync(600));
  expect(jobs).toHaveLength(1);
  rerender(<Fixture idle />);
  await act(async () => vi.advanceTimersByTimeAsync(500));
  expect(descriptorRequests).toHaveLength(0);
  expect(jobs).toHaveLength(2);
  expect(jobs[1].url).toBe("http://gallery/20/256");
  expect(jobs[1].options).toMatchObject({ priority: 2, retainDecoded: false });
  expect(screen.getByTestId("resource").textContent).toContain("?select=1");
  rerender(<Fixture idle requestImage={false} />);
  expect(jobs[1].release).toHaveBeenCalled();
});
it("repairs a selected legacy cover once when its pixels cannot decode", async () => {
  render(<Fixture />);
  await act(async () => jobs[0].resolve("failed"));
  expect(jobs).toHaveLength(2);
  expect(jobs[1].url).toBe("http://gallery/20/256?repair=1");
  await act(async () => jobs[1].resolve("loaded"));
  expect(screen.getByTestId("resource").textContent).toBe(
    "http://gallery/20/256?repair=1"
  );
});
it("stops after one failed repair instead of looping over damaged resources", async () => {
  render(<Fixture />);
  await act(async () => jobs[0].resolve("failed"));
  expect(jobs).toHaveLength(2);
  expect(jobs[1].url).toContain("?repair=1");
  await act(async () => jobs[1].resolve("failed"));
  expect(jobs).toHaveLength(2);
  expect(screen.getByTestId("resource").textContent).toBe("");
});
it("repairs a failed retained larger cover at the currently requested edge", async () => {
  const first = render(<Fixture />);
  const url = jobs[0].url;
  readyUrls.add(url);
  await act(async () => jobs[0].resolve("loaded"));
  first.unmount();
  render(<Fixture />);
  expect(jobs[1].url).toBe(url);
  await act(async () => jobs[1].resolve("failed"));
  expect(jobs).toHaveLength(3);
  expect(jobs[2].url).toBe("http://gallery/20/256?repair=1");
  expect(screen.getByTestId("resource").textContent).toBe(url);
});
it("does not repeat idle source lookup when a lightweight record hydrates its path", async () => {
  const { rerender } = render(<Fixture idle visible={false} />);
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    jobs[0].resolve("loaded");
    await Promise.resolve();
  });
  expect(descriptorRequests).toHaveLength(1);
  expect(jobs).toHaveLength(1);
  rerender(<Fixture idle sourceKey="photo.jpg" visible={false} />);
  await act(async () => {
    await Promise.resolve();
  });
  expect(descriptorRequests).toHaveLength(1);
  expect(jobs).toHaveLength(1);
  rerender(<Fixture idle sourceKey="renamed.jpg" visible={false} />);
  await act(async () => {
    await Promise.resolve();
  });
  expect(descriptorRequests).toHaveLength(2);
  expect(descriptorRequests[1]).not.toBe(descriptorRequests[0]);
  expect(jobs).toHaveLength(2);
});
it("retries a visible failed cover after its existing source path is rebound", async () => {
  const { rerender } = render(<Fixture id={21} sourceKey="missing.jpg" />);
  await act(async () => jobs[0].resolve("failed"));
  await act(async () => jobs[1].resolve("failed"));
  expect(screen.getByTestId("resource")).toHaveAttribute("data-failed", "true");
  rerender(<Fixture id={21} sourceKey="valid-relinked.jpg" />);
  expect(jobs).toHaveLength(3);
  expect(jobs[2].url).toContain("v=test%3Asource-1");
  expect(jobs[2].url).not.toContain("repair=1");
  expect(jobs[2].url).not.toContain("valid-relinked");
  expect(descriptorRequests).toHaveLength(0);
  await act(async () => jobs[2].resolve("loaded"));
  expect(screen.getByTestId("resource").textContent).toBe(jobs[2].url);
  expect(screen.getByTestId("resource")).toHaveAttribute(
    "data-failed",
    "false"
  );
});
it("replaces a decoded cover after a source change and retains that source through a remount", async () => {
  const { rerender, unmount } = render(
    <Fixture id={22} sourceKey="original.jpg" />
  );
  const original = jobs[0].url;
  readyUrls.add(original);
  await act(async () => jobs[0].resolve("loaded"));
  rerender(<Fixture id={22} sourceKey="replacement.jpg" />);
  expect(jobs).toHaveLength(2);
  expect(jobs[1].url).not.toBe(original);
  expect(screen.getByTestId("resource").textContent).not.toBe(original);
  const replacement = jobs[1].url;
  readyUrls.add(replacement);
  await act(async () => jobs[1].resolve("loaded"));
  expect(screen.getByTestId("resource").textContent).toBe(replacement);
  unmount();
  render(<Fixture id={22} sourceKey="replacement.jpg" />);
  expect(screen.getByTestId("resource").textContent).toBe(replacement);
  expect(jobs[2].url).toBe(replacement);
});
it("does not revive a decoded prior path when a card remounts after rebinding", async () => {
  const first = render(<Fixture id={23} sourceKey="old.jpg" />);
  const original = jobs[0].url;
  readyUrls.add(original);
  await act(async () => jobs[0].resolve("loaded"));
  first.unmount();
  render(<Fixture id={23} sourceKey="new.jpg" />);
  expect(screen.getByTestId("resource").textContent).toBe("");
  expect(jobs[1].url).not.toBe(original);
  await act(async () => jobs[1].resolve("loaded"));
  expect(screen.getByTestId("resource").textContent).toBe(jobs[1].url);
});
it("discards an obsolete offscreen descriptor when the source path changes", async () => {
  descriptorControl.defer = true;
  const { rerender } = render(
    <Fixture id={24} sourceKey="old.jpg" visible={false} />
  );
  expect(descriptorJobs).toHaveLength(1);
  rerender(<Fixture id={24} sourceKey="new.jpg" visible={false} />);
  expect(descriptorJobs).toHaveLength(2);
  expect(descriptorJobs[0].release).toHaveBeenCalled();
  await act(async () =>
    descriptorJobs[0].resolve({ thumbnailVersion: "obsolete" })
  );
  expect(jobs).toHaveLength(0);
  await act(async () =>
    descriptorJobs[1].resolve({ thumbnailVersion: "current" })
  );
  expect(jobs).toHaveLength(1);
  expect(jobs[0].url).toContain("v=test%3Asource-1");
  await act(async () => jobs[0].resolve("loaded"));
  expect(screen.getByTestId("resource").textContent).toBe(jobs[0].url);
});
