import { describe, expect, it } from "vitest";
import { shouldShowHomeGallery } from "@/routes/-home-gallery-state";

const baseInput = {
  activeFolderId: null,
  activeTagCount: 0,
  favoriteOnly: false,
  isSearching: false,
  loading: false,
  photoCount: 0,
};

describe("shouldShowHomeGallery", () => {
  it("keeps the first-use welcome state for a truly empty library", () => {
    expect(shouldShowHomeGallery(baseInput)).toBe(false);
  });

  it("keeps active folder and tag scopes in the gallery empty state", () => {
    expect(shouldShowHomeGallery({ ...baseInput, activeFolderId: 12 })).toBe(
      true
    );
    expect(shouldShowHomeGallery({ ...baseInput, activeTagCount: 2 })).toBe(
      true
    );
  });

  it("keeps the gallery mounted when the initial query fails", () => {
    expect(
      shouldShowHomeGallery({ ...baseInput, initialQueryError: true })
    ).toBe(true);
  });
});
