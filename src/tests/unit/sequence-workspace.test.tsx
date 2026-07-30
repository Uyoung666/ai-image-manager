import { fireEvent, render, screen } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  SequenceWorkspace,
  type SequenceWorkspaceProps,
} from "@/components/SequenceWorkspace";
import type { Photo } from "@/types/photo";

const actionMocks = vi.hoisted(() => ({
  dissolve: vi.fn(),
  keep: vi.fn(),
  recommendRepresentative: vi.fn(),
  removeMembers: vi.fn(),
  setRepresentative: vi.fn(),
  split: vi.fn(),
  updateMembers: vi.fn(),
}));
const OUT_OF_SCOPE_WARNING = /范围外照片不受影响/;

vi.mock("@/actions/photo-sequences", () => ({
  photoSequenceActions: actionMocks,
}));

vi.mock("@/components/PhotoCard", () => ({
  PhotoCard: ({
    filename,
    id,
    isSelected,
    onClick,
    onDoubleClick,
  }: {
    filename: string;
    id: number;
    isSelected: boolean;
    onClick: (id: number, event: React.MouseEvent) => void;
    onDoubleClick: (id: number) => void;
  }) => (
    <button
      aria-pressed={isSelected}
      data-photo-card={id}
      onClick={(event) => onClick(id, event)}
      onDoubleClick={() => onDoubleClick(id)}
      type="button"
    >
      {filename}
    </button>
  ),
}));

class ResizeObserverMock {
  disconnect() {
    return undefined;
  }

  observe() {
    return undefined;
  }

  unobserve() {
    return undefined;
  }
}

const originalGetBoundingClientRect =
  HTMLElement.prototype.getBoundingClientRect;
const originalClientHeight = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "clientHeight"
);
const originalClientWidth = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "clientWidth"
);

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  Object.defineProperties(HTMLElement.prototype, {
    clientHeight: { configurable: true, get: () => 720 },
    clientWidth: { configurable: true, get: () => 1280 },
  });
  HTMLElement.prototype.getBoundingClientRect = () =>
    ({
      bottom: 720,
      height: 720,
      left: 0,
      right: 1280,
      top: 0,
      width: 1280,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
});

afterAll(() => {
  HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
  if (originalClientHeight) {
    Object.defineProperty(
      HTMLElement.prototype,
      "clientHeight",
      originalClientHeight
    );
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, "clientHeight");
  }
  if (originalClientWidth) {
    Object.defineProperty(
      HTMLElement.prototype,
      "clientWidth",
      originalClientWidth
    );
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, "clientWidth");
  }
  vi.unstubAllGlobals();
});

function makePhotos(count: number, offset = 0): Photo[] {
  return Array.from({ length: count }, (_, index) => {
    const id = offset + index + 1;
    return {
      fileSize: 100,
      filename: `${id}.jpg`,
      height: 3000,
      id,
      isIndexed: true,
      path: `C:/Photos/${id}.jpg`,
      thumbnailPath: null,
      width: 4000,
    };
  });
}

function makeProps(
  overrides: Partial<SequenceWorkspaceProps> = {}
): SequenceWorkspaceProps {
  const completeMembers = makePhotos(1000);
  return {
    completeMembers,
    currentMembers: completeMembers.slice(0, 500),
    currentScopeLabel: "本相册",
    onClose: vi.fn(),
    onOpenDetails: vi.fn(),
    onPlay: vi.fn(),
    onSelectionChange: vi.fn(),
    open: true,
    selectedPhotoIds: new Set(),
    ...overrides,
  };
}

describe("SequenceWorkspace", () => {
  it("renders nothing while closed", () => {
    const { container } = render(
      <SequenceWorkspace {...makeProps({ open: false })} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("defaults to the current scope and keeps 500 items DOM-bounded", () => {
    render(<SequenceWorkspace {...makeProps()} />);

    expect(screen.getByText("本相册 500/完整序列 1000 张")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "本相册（500）" })
    ).toHaveAttribute("aria-pressed", "true");
    const renderedCards = document.querySelectorAll("[data-photo-card]");
    expect(renderedCards.length).toBeGreaterThan(0);
    expect(renderedCards.length).toBeLessThan(100);
  });

  it("switches to all 1000 members without rendering every photo", () => {
    const onSelectionChange = vi.fn();
    render(
      <SequenceWorkspace
        {...makeProps({
          onSelectionChange,
          selectedPhotoIds: new Set([1, 700]),
        })}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "完整序列（1000）" }));

    expect(onSelectionChange).toHaveBeenCalledWith(new Set());
    expect(
      screen.getByRole("button", { name: "完整序列（1000）" })
    ).toHaveAttribute("aria-pressed", "true");
    const renderedCards = document.querySelectorAll("[data-photo-card]");
    expect(renderedCards.length).toBeGreaterThan(0);
    expect(renderedCards.length).toBeLessThan(100);
  });

  it("selects one frame and opens its details independently", () => {
    const onOpenDetails = vi.fn();
    const onSelectionChange = vi.fn();
    const currentMembers = makePhotos(12);
    render(
      <SequenceWorkspace
        {...makeProps({
          completeMembers: currentMembers,
          currentMembers,
          onOpenDetails,
          onSelectionChange,
        })}
      />
    );

    const firstPhoto = screen.getByRole("button", { name: "1.jpg" });
    fireEvent.click(firstPhoto);
    expect(onSelectionChange).toHaveBeenCalledWith(new Set([1]));

    fireEvent.doubleClick(firstPhoto);
    expect(onOpenDetails).toHaveBeenCalledWith(1, currentMembers);
  });

  it("selects the active range and plays the active range", () => {
    const currentMembers = makePhotos(24);
    const completeMembers = makePhotos(60);
    const onPlay = vi.fn();
    const onSelectionChange = vi.fn();
    render(
      <SequenceWorkspace
        {...makeProps({
          completeMembers,
          currentMembers,
          onPlay,
          onSelectionChange,
        })}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "全选本相册" }));
    expect(onSelectionChange).toHaveBeenCalledWith(
      new Set(currentMembers.map((photo) => photo.id))
    );

    fireEvent.click(screen.getByRole("button", { name: "播放" }));
    expect(onPlay).toHaveBeenCalledWith(currentMembers);
  });

  it("closes from the return button and Escape", () => {
    const onClose = vi.fn();
    render(<SequenceWorkspace {...makeProps({ onClose })} />);

    fireEvent.click(screen.getByRole("button", { name: "返回照片流" }));
    fireEvent.keyDown(window, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("keeps the selected current-scope frames and deletes only that scope's remainder", () => {
    actionMocks.recommendRepresentative.mockResolvedValue(null);
    actionMocks.keep.mockResolvedValue({ deleted: 2 });
    const completeMembers = makePhotos(6);
    const currentMembers = completeMembers.slice(0, 4);
    render(
      <SequenceWorkspace
        {...makeProps({
          completeMembers,
          currentMembers,
          selectedPhotoIds: new Set([1, 2]),
          sequenceId: 10,
        })}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "保留所选，删除其余" }));
    expect(screen.getByText(OUT_OF_SCOPE_WARNING)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "保留并删除其余" }));

    expect(actionMocks.keep).toHaveBeenCalledWith(10, [1, 2], [1, 2, 3, 4]);
  });

  it("exposes structural member removal only in the complete-sequence scope", () => {
    actionMocks.recommendRepresentative.mockResolvedValue(null);
    actionMocks.removeMembers.mockResolvedValue({ dissolved: false });
    const members = makePhotos(6);
    const { rerender } = render(
      <SequenceWorkspace
        {...makeProps({
          completeMembers: members,
          currentMembers: members.slice(0, 4),
          selectedPhotoIds: new Set([1, 2]),
          sequenceId: 10,
        })}
      />
    );
    expect(
      screen.queryByRole("button", { name: "移出序列" })
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "完整序列（6）" }));
    rerender(
      <SequenceWorkspace
        {...makeProps({
          completeMembers: members,
          currentMembers: members.slice(0, 4),
          selectedPhotoIds: new Set([1, 2]),
          sequenceId: 10,
        })}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "移出序列" }));
    const removeButtons = screen.getAllByRole("button", {
      name: "移出序列",
    });
    const confirmRemove = removeButtons.at(-1);
    expect(confirmRemove).toBeDefined();
    if (confirmRemove) {
      fireEvent.click(confirmRemove);
    }

    expect(actionMocks.removeMembers).toHaveBeenCalledWith(10, [1, 2]);
  });
});
