import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SequenceDetailPanel } from "@/components/SequenceDetailPanel";
import type { PhotoSequenceDetail } from "@/types/photo-sequence";

vi.mock("@/actions/photo-sequences", () => ({
  photoSequenceActions: {
    recommendRepresentative: vi.fn(() => new Promise<never>(() => undefined)),
  },
}));

const sequence: PhotoSequenceDetail = {
  endedAt: 2,
  frameCount: 2,
  id: 10,
  members: [
    {
      filename: "1.jpg",
      fileSize: 1024,
      height: 1000,
      id: 1,
      isIndexed: true,
      path: "C:/photos/1.jpg",
      thumbnailPath: null,
      width: 1500,
    },
    {
      filename: "2.jpg",
      fileSize: 1024,
      height: 1000,
      id: 2,
      isIndexed: true,
      path: "C:/photos/2.jpg",
      thumbnailPath: null,
      width: 1500,
    },
  ],
  representativePhotoId: 1,
  source: "auto",
  startedAt: 1,
  type: "burst",
  userLocked: false,
};

describe("SequenceDetailPanel", () => {
  it("reserves recommendation space with a skeleton while loading", () => {
    render(
      <SequenceDetailPanel
        onClose={vi.fn()}
        onOpenPhoto={vi.fn()}
        onPlay={vi.fn()}
        sequence={sequence}
        width={360}
      />
    );

    expect(screen.getByLabelText("正在加载推荐代表帧")).toBeInTheDocument();
  });
});
