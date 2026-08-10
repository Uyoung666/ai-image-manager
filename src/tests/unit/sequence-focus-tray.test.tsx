import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SequenceFocusTray } from "@/components/PhotoGrid";
import type { PhotoSequenceDetail } from "@/types/photo-sequence";

const { updateMembers } = vi.hoisted(() => ({
  updateMembers: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("@/actions/photo-sequences", () => ({
  photoSequenceActions: {
    dissolve: vi.fn(),
    dissolveAndExclude: vi.fn(),
    removeMembers: vi.fn(),
    split: vi.fn(),
    updateMembers,
  },
}));

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
  it("optimistically shows the new order without collapsing the tray", async () => {
    updateMembers.mockClear();
    const heightSpy = vi
      .spyOn(HTMLElement.prototype, "offsetHeight", "get")
      .mockReturnValue(560);
    const widthSpy = vi
      .spyOn(HTMLElement.prototype, "offsetWidth", "get")
      .mockReturnValue(900);
    const onSequenceMutationComplete = vi.fn();
    const onBackgroundClick = vi.fn();
    document.body.addEventListener("click", onBackgroundClick);
    try {
      const { container } = render(
        <SequenceFocusTray
          columns={3}
          completeMembers={sequence.members}
          containerWidth={900}
          getDragIds={(id) => [id]}
          onDoubleClick={vi.fn()}
          onSelect={vi.fn()}
          onSequenceMutationComplete={onSequenceMutationComplete}
          renderImage={false}
          selectedIds={new Set([3])}
          sequence={{ ...sequence, members: sequence.members.slice(0, 6) }}
        />
      );

      fireEvent.click(screen.getByRole("button", { name: "sequenceMoveDown" }));

      await waitFor(() => expect(updateMembers).toHaveBeenCalledOnce());
      expect(updateMembers.mock.calls[0][1].slice(0, 6)).toEqual([
        1, 2, 4, 3, 5, 6,
      ]);
      expect(
        Array.from(container.querySelectorAll("[data-sequence-member-id]"))
          .slice(0, 6)
          .map((element) =>
            Number(element.getAttribute("data-sequence-member-id"))
          )
      ).toEqual([1, 2, 4, 3, 5, 6]);
      expect(screen.getByRole("status")).toBeInTheDocument();
      expect(onSequenceMutationComplete).not.toHaveBeenCalled();
      expect(onBackgroundClick).not.toHaveBeenCalled();
    } finally {
      document.body.removeEventListener("click", onBackgroundClick);
      heightSpy.mockRestore();
      widthSpy.mockRestore();
    }
  });

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
