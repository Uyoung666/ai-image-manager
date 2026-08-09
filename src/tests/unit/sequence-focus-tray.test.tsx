import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SequenceFocusTray } from "@/components/PhotoGrid";
import type { PhotoSequenceDetail } from "@/types/photo-sequence";

const memberCount = 1000;
const sequence: PhotoSequenceDetail = {
  endedAt: memberCount,
  frameCount: memberCount,
  id: 42,
  members: Array.from({ length: memberCount }, (_, index) => ({
    filename: `frame-${index}.jpg`,
    fileSize: 1024,
    height: 1000,
    id: index + 1,
    isIndexed: true,
    path: `C:/photos/frame-${index}.jpg`,
    thumbnailPath: null,
    width: 1500,
  })),
  representativePhotoId: 1,
  source: "auto",
  startedAt: 0,
  type: "timelapse",
  userLocked: false,
};

describe("SequenceFocusTray", () => {
  it("keeps all structural sequence actions in the inline tray", () => {
    render(
      <SequenceFocusTray
        columns={3}
        completeMembers={sequence.members}
        containerWidth={900}
        getDragIds={(id) => [id]}
        onDoubleClick={vi.fn()}
        onSelect={vi.fn()}
        renderImage={false}
        selectedIds={new Set([3])}
        sequence={{
          ...sequence,
          frameCount: 6,
          members: sequence.members.slice(0, 6),
        }}
      />
    );

    expect(screen.getByRole("button", { name: "移出" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "sequenceMoveUp" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "sequenceMoveDown" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "从此拆分" })
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "解散" })).toBeInTheDocument();
  });

  it("keeps long sequences inline and only renders virtual rows", () => {
    const heightSpy = vi
      .spyOn(HTMLElement.prototype, "offsetHeight", "get")
      .mockReturnValue(560);
    const widthSpy = vi
      .spyOn(HTMLElement.prototype, "offsetWidth", "get")
      .mockReturnValue(1200);
    const { container, unmount } = render(
      <SequenceFocusTray
        columns={6}
        containerWidth={1200}
        getDragIds={(id) => [id]}
        onDoubleClick={vi.fn()}
        onSelect={vi.fn()}
        renderImage={false}
        selectedIds={new Set()}
        sequence={sequence}
      />
    );

    const scrollArea = container.querySelector<HTMLElement>(
      "[data-sequence-virtual-scroll]"
    );
    const renderedCards = container.querySelectorAll("[data-photo-id]");
    const renderedRows = container.querySelectorAll(
      "[data-sequence-virtual-row]"
    );

    expect(scrollArea?.style.height).toBe("560px");
    expect(renderedRows.length).toBeGreaterThan(0);
    expect(renderedCards.length).toBeGreaterThan(0);
    expect(renderedCards.length).toBeLessThan(memberCount);
    unmount();
    heightSpy.mockRestore();
    widthSpy.mockRestore();
  });
});
