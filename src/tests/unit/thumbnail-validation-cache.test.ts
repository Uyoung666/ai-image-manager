/** @vitest-environment node */
import fs from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearThumbnailValidation,
  readValidatedThumbnail,
  validateThumbnail,
} from "@/services/thumbnail-validation";

const state = vi.hoisted(() => ({ metadata: vi.fn() }));
vi.mock("sharp", () => ({ default: () => ({ metadata: state.metadata }) }));
const stat = (mtimeMs = 1) =>
  ({ size: 80, mtimeMs, ctimeMs: mtimeMs, birthtimeMs: 1 }) as fs.Stats;
beforeEach(() => {
  clearThumbnailValidation();
  state.metadata.mockReset().mockResolvedValue({ width: 256, height: 128 });
});
describe("thumbnail validation LRU", () => {
  it("shares a cold small file's bytes without keeping buffers in the validation LRU", async () => {
    const bytes = Buffer.alloc(80);
    const read = vi.spyOn(fs.promises, "readFile").mockResolvedValue(bytes);
    try {
      const [first, shared] = await Promise.all([
        readValidatedThumbnail("fixture.webp", stat()),
        readValidatedThumbnail("fixture.webp", stat()),
      ]);
      expect(first.buffer).toBe(bytes);
      expect(shared).toBe(first);
      expect(read).toHaveBeenCalledTimes(1);
      expect(state.metadata).toHaveBeenCalledTimes(1);
      expect(
        (await readValidatedThumbnail("fixture.webp", stat())).buffer
      ).toBeUndefined();
      expect(read).toHaveBeenCalledTimes(1);
    } finally {
      read.mockRestore();
    }
  });
  it("keeps larger validation resources on the streaming path", async () => {
    const read = vi.spyOn(fs.promises, "readFile");
    try {
      const result = await readValidatedThumbnail("large.webp", {
        ...stat(),
        size: 300 * 1024,
      } as fs.Stats);
      expect(result.buffer).toBeUndefined();
      expect(read).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
    }
  });
  it("shares concurrent validation and skips unchanged resident identities", async () => {
    await Promise.all([
      validateThumbnail("fixture.webp", stat()),
      validateThumbnail("fixture.webp", stat()),
    ]);
    await validateThumbnail("fixture.webp", stat());
    expect(state.metadata).toHaveBeenCalledTimes(1);
    await validateThumbnail("fixture.webp", stat(2));
    expect(state.metadata).toHaveBeenCalledTimes(2);
  });
  it("never caches a corrupt result as successful and releases entries on close", async () => {
    state.metadata.mockRejectedValueOnce(new Error("corrupt"));
    await expect(validateThumbnail("broken.webp", stat())).rejects.toThrow(
      "corrupt"
    );
    await validateThumbnail("broken.webp", stat());
    clearThumbnailValidation();
    await validateThumbnail("broken.webp", stat());
    expect(state.metadata).toHaveBeenCalledTimes(3);
  });
  it("bounds successful validations at 4096", async () => {
    for (let index = 0; index < 4097; index++) {
      await validateThumbnail(`entry-${index}.webp`, stat());
    }
    await validateThumbnail("entry-0.webp", stat());
    expect(state.metadata).toHaveBeenCalledTimes(4098);
  });
});
