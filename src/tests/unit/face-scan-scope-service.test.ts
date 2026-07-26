import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSetting: vi.fn(),
  setSetting: vi.fn(),
}));

vi.mock("@/db", () => ({
  getDatabase: () => ({
    select: () => ({
      from: () => ({
        all: () => [
          { id: 1, parentId: null },
          { id: 2, parentId: 1 },
          { id: 3, parentId: null },
        ],
      }),
    }),
  }),
}));

vi.mock("@/services/settings-manager", () => ({
  getSetting: mocks.getSetting,
  setSetting: mocks.setSetting,
}));

import {
  getFaceScanScope,
  resolveFaceScanFolderIds,
  setFaceScanScope,
} from "@/services/face-scan-scope";

describe("face scan scope persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("prunes invalid and redundant stored folder ids", () => {
    mocks.getSetting.mockReturnValue("[2,1,999]");

    expect(getFaceScanScope()).toEqual({ configured: true, folderIds: [1] });
    expect(resolveFaceScanFolderIds()).toEqual([1, 2]);
  });

  it("stores normalized roots", () => {
    expect(setFaceScanScope([2, 1, 3])).toEqual({
      configured: true,
      folderIds: [1, 3],
    });
    expect(mocks.setSetting).toHaveBeenCalledWith(
      "faces.scanFolderIds",
      "[1,3]"
    );
  });

  it("rejects an empty or fully invalid scope", () => {
    expect(() => setFaceScanScope([999])).toThrow("请至少选择一个有效文件夹");
    expect(mocks.setSetting).not.toHaveBeenCalled();
  });
});
