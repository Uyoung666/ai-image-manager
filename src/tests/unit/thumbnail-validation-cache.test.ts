/** @vitest-environment node */
import type fs from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearThumbnailValidation,
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
