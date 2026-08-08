import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifyExternalDrop,
  getDroppedFolderPaths,
  getDroppedImagePath,
} from "@/utils/drop-import";

interface FakeDropItemOptions {
  directory?: boolean;
  entryUnavailable?: boolean;
  fileUnavailable?: boolean;
  mimeType?: string;
  name: string;
  path: string;
}

function createDataTransfer(
  items: FakeDropItemOptions[],
  types = ["Files"]
): DataTransfer {
  const dataItems = items.map((item) => {
    const file = new File(["content"], item.name, {
      type:
        item.mimeType ??
        (item.directory ? "application/x-directory" : "image/jpeg"),
    });
    return {
      getAsFile: () => (item.fileUnavailable ? null : file),
      kind: "file",
      type: item.mimeType ?? file.type,
      webkitGetAsEntry: () =>
        item.entryUnavailable ? null : { isDirectory: item.directory === true },
    };
  });

  vi.mocked(window.electronAPI.getFilePath).mockImplementation((file) => {
    const match = items.find((item) => item.name === file.name);
    return match?.path ?? file.name;
  });

  return {
    items: dataItems,
    types,
  } as unknown as DataTransfer;
}

describe("external drop import classification", () => {
  beforeEach(() => {
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: {
        getFilePath: vi.fn(),
        isDirectoryPath: vi.fn(),
      },
    });
  });

  it("accepts exactly one supported image without treating it as a folder", () => {
    const dataTransfer = createDataTransfer([
      { name: "photo.jpg", path: "C:/Photos/photo.jpg" },
    ]);

    expect(classifyExternalDrop(dataTransfer)).toBe("image");
    expect(getDroppedImagePath(dataTransfer)).toBe("C:/Photos/photo.jpg");
    expect(getDroppedFolderPaths(dataTransfer)).toEqual([]);
  });

  it("recognizes a single image while native paths are protected", () => {
    const dataTransfer = createDataTransfer([
      {
        entryUnavailable: true,
        fileUnavailable: true,
        mimeType: "image/jpeg",
        name: "photo.jpg",
        path: "C:/Photos/photo.jpg",
      },
    ]);

    expect(classifyExternalDrop(dataTransfer)).toBe("image");
    expect(getDroppedImagePath(dataTransfer)).toBeNull();
  });

  it("rejects multiple files and unsupported files", () => {
    const multiple = createDataTransfer([
      { name: "one.jpg", path: "C:/Photos/one.jpg" },
      { name: "two.jpg", path: "C:/Photos/two.jpg" },
    ]);
    const unsupported = createDataTransfer([
      {
        mimeType: "text/plain",
        name: "notes.txt",
        path: "C:/Photos/notes.txt",
      },
    ]);

    expect(classifyExternalDrop(multiple)).toBe("invalid");
    expect(classifyExternalDrop(unsupported)).toBe("invalid");
    expect(getDroppedImagePath(multiple)).toBeNull();
  });

  it("accepts one or more pure folders and preserves their actual paths", () => {
    const dataTransfer = createDataTransfer([
      { directory: true, name: "Travel", path: "C:/Photos/Travel" },
      { directory: true, name: "Work", path: "C:/Photos/Work" },
    ]);

    expect(classifyExternalDrop(dataTransfer)).toBe("folders");
    expect(getDroppedFolderPaths(dataTransfer)).toEqual([
      "C:/Photos/Travel",
      "C:/Photos/Work",
    ]);
  });

  it("recognizes a folder when the entry API is unavailable during dragover", () => {
    const isDirectoryPath = window.electronAPI.isDirectoryPath;
    expect(isDirectoryPath).toBeDefined();
    if (isDirectoryPath) {
      vi.mocked(isDirectoryPath).mockReturnValue(true);
    }
    const dataTransfer = createDataTransfer([
      {
        directory: true,
        entryUnavailable: true,
        name: "Travel",
        path: "C:/Photos/Travel",
      },
    ]);

    expect(classifyExternalDrop(dataTransfer)).toBe("folders");
    expect(getDroppedFolderPaths(dataTransfer)).toEqual(["C:/Photos/Travel"]);
  });

  it("recognizes folder candidates while native paths are protected", () => {
    const dataTransfer = createDataTransfer([
      {
        directory: true,
        entryUnavailable: true,
        fileUnavailable: true,
        mimeType: "",
        name: "Travel",
        path: "C:/Photos/Travel",
      },
    ]);

    expect(classifyExternalDrop(dataTransfer)).toBe("folders");
    expect(getDroppedFolderPaths(dataTransfer)).toEqual([]);
  });

  it("rejects mixed files and folders", () => {
    const dataTransfer = createDataTransfer([
      { directory: true, name: "Travel", path: "C:/Photos/Travel" },
      { name: "photo.jpg", path: "C:/Photos/photo.jpg" },
    ]);

    expect(classifyExternalDrop(dataTransfer)).toBe("invalid");
  });

  it("ignores application-internal photo drags", () => {
    const dataTransfer = createDataTransfer(
      [{ name: "photo.jpg", path: "C:/Photos/photo.jpg" }],
      ["application/x-photo-ids"]
    );

    expect(classifyExternalDrop(dataTransfer)).toBeNull();
    expect(getDroppedImagePath(dataTransfer)).toBeNull();
    expect(getDroppedFolderPaths(dataTransfer)).toEqual([]);
  });

  it("ignores an internal photo drag even when Files is also present", () => {
    const dataTransfer = createDataTransfer(
      [{ name: "photo.jpg", path: "C:/Photos/photo.jpg" }],
      ["application/x-photo-ids", "Files"]
    );

    expect(classifyExternalDrop(dataTransfer)).toBeNull();
    expect(getDroppedImagePath(dataTransfer)).toBeNull();
  });
});
