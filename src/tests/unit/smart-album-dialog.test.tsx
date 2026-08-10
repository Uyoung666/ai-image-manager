import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SmartAlbumDialog } from "@/components/SmartAlbumDialog";

const { validateSmartAlbumRules } = vi.hoisted(() => ({
  validateSmartAlbumRules: vi.fn().mockResolvedValue({ matchCount: 0 }),
}));

vi.mock("@/ipc/manager", () => ({
  ipc: {
    client: {
      albums: {
        createAlbum: vi.fn(),
        validateSmartAlbumRules,
      },
      photos: {
        getExifCandidates: vi.fn().mockResolvedValue({}),
        getTags: vi.fn().mockResolvedValue([]),
      },
    },
  },
}));

vi.mock("@/localization/i18n", () => ({
  default: { t: (key: string) => key },
}));

describe("SmartAlbumDialog", () => {
  afterEach(() => {
    vi.useRealTimers();
    validateSmartAlbumRules.mockClear();
  });

  it("does not enter an update loop after adding a rule", () => {
    vi.useFakeTimers();
    render(<SmartAlbumDialog onClose={vi.fn()} onCreated={vi.fn()} open />);

    fireEvent.click(screen.getByRole("button", { name: "smartAlbumAddRule" }));

    expect(screen.getAllByRole("combobox")).toHaveLength(2);
    vi.advanceTimersByTime(400);
    expect(validateSmartAlbumRules).toHaveBeenCalledTimes(1);
  });
});
