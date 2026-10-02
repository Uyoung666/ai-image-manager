import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PhotoGrid } from "@/components/PhotoGrid";
import type { Photo } from "@/types/photo";
import type { PhotoSequence } from "@/types/photo-sequence";

vi.mock("@/components/MasonryGrid", () => ({
  MasonryGrid: ({
    items,
    onMarqueeSelect,
  }: {
    items: Photo[];
    onMarqueeSelect: (ids: Set<number>) => void;
  }) => (
    <div data-testid="grid">
      {items.map((photo) => (
        <span data-testid={`photo-${photo.id}`} key={photo.id}>
          {photo.filename}
        </span>
      ))}
      <button onClick={() => onMarqueeSelect(new Set([1]))} type="button">
        marquee
      </button>
    </div>
  ),
}));
const photos = [1, 2, 3].map((id) => ({
  id,
  filename: `${id}.jpg`,
  fileDate: id,
  fileSize: 100,
  width: 100,
  height: 80,
  path: `C:/fixture/${id}.jpg`,
})) as Photo[];
const sequence = {
  id: 10,
  photo: photos[0],
  representativePhotoId: 1,
  matchedPhotoIds: [1, 2],
  memberPhotoIds: [1, 2],
} as PhotoSequence;
const props = {
  loading: false,
  photos,
  routeKey: "grid-test",
  selectedIds: new Set<number>(),
  onSelect: vi.fn(),
  onDoubleClick: vi.fn(),
  onContextMenu: vi.fn(),
  sequences: [sequence],
};

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {
        return undefined;
      }
      disconnect() {
        return undefined;
      }
      unobserve() {
        return undefined;
      }
    }
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("photo grid separation", () => {
  it("offers sequence navigation for a library containing only sequence members", () => {
    const changeMode = vi.fn();
    render(
      <PhotoGrid
        {...props}
        onSequenceModeChange={changeMode}
        sequenceMode="photos"
        sequences={[{ ...sequence, matchedPhotoIds: [1, 2, 3] }]}
      />
    );
    expect(screen.queryByTestId("grid")).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "sequenceEmptyViewSequences" })
    );
    expect(changeMode).toHaveBeenCalledWith("sequences");
  });
  it("keeps a filter matching one sequence member out of the photo view", () => {
    const scoped = {
      ...sequence,
      matchedPhotoIds: [2],
      matchedPhoto: photos[1],
    };
    const { rerender } = render(
      <PhotoGrid
        {...props}
        photos={[photos[1]]}
        sequenceMode="photos"
        sequences={[scoped]}
      />
    );
    expect(screen.queryByTestId("photo-2")).not.toBeInTheDocument();
    rerender(
      <PhotoGrid
        {...props}
        photos={[photos[1]]}
        sequenceMode="sequences"
        sequences={[scoped]}
      />
    );
    expect(screen.getByTestId("photo-2")).toBeInTheDocument();
    expect(screen.queryByTestId("photo-1")).not.toBeInTheDocument();
  });
  it("shows an empty sequence view when no sequences exist", () => {
    render(<PhotoGrid {...props} sequenceMode="sequences" sequences={[]} />);
    expect(screen.queryByTestId("grid")).not.toBeInTheDocument();
    expect(screen.getByText("还没有照片，请先添加文件夹")).toBeInTheDocument();
  });
  it("shows only standalone photos and switches to sequence representatives", () => {
    const { rerender } = render(<PhotoGrid {...props} sequenceMode="photos" />);
    expect(screen.queryByTestId("photo-1")).not.toBeInTheDocument();
    expect(screen.queryByTestId("photo-2")).not.toBeInTheDocument();
    expect(screen.getByTestId("photo-3")).toBeInTheDocument();
    rerender(<PhotoGrid {...props} sequenceMode="sequences" />);
    expect(screen.getByTestId("photo-1")).toBeInTheDocument();
    expect(screen.queryByTestId("photo-3")).not.toBeInTheDocument();
  });
  it("expands a sequence marquee to scoped member IDs", () => {
    const select = vi.fn();
    render(
      <PhotoGrid {...props} onMarqueeSelect={select} sequenceMode="sequences" />
    );
    fireEvent.click(screen.getByRole("button", { name: "marquee" }));
    expect(select).toHaveBeenCalledWith(new Set([1, 2]));
  });
  it("blocks unknown ownership on failure and keeps confirmed results on refresh failure", () => {
    const retry = vi.fn();
    const { rerender } = render(
      <PhotoGrid
        {...props}
        onRetrySequences={retry}
        sequenceError="load failed"
      />
    );
    expect(screen.queryByTestId("grid")).not.toBeInTheDocument();
    rerender(
      <PhotoGrid
        {...props}
        onRetrySequences={retry}
        preserveOnSequenceError
        sequenceError="load failed"
      />
    );
    expect(screen.getByTestId("photo-3")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "retry" }));
    expect(retry).toHaveBeenCalledOnce();
  });
});
