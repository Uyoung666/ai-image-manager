import { afterEach, describe, expect, it } from "vitest";
import {
  beginAutoTagging,
  finishAutoTagging,
  finishAutoTaggingPhoto,
  isAutoTaggingActive,
  isAutoTaggingPhoto,
} from "@/services/ai/state";

const TEST_IDS = [91_001, 91_002];

describe("AI auto-tag task state", () => {
  afterEach(() => finishAutoTagging(TEST_IDS));

  it("tracks the whole batch and each active photo", () => {
    beginAutoTagging(TEST_IDS);

    expect(isAutoTaggingActive()).toBe(true);
    expect(isAutoTaggingPhoto(TEST_IDS[0])).toBe(true);
    expect(isAutoTaggingPhoto(TEST_IDS[1])).toBe(true);

    finishAutoTaggingPhoto(TEST_IDS[0]);
    expect(isAutoTaggingPhoto(TEST_IDS[0])).toBe(false);
    expect(isAutoTaggingActive()).toBe(true);

    finishAutoTaggingPhoto(TEST_IDS[1]);
    expect(isAutoTaggingActive()).toBe(false);
  });
});
