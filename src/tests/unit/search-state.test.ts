import { describe, expect, it } from "vitest";
import { shouldRestoreSavedSearch } from "@/utils/search-state";

describe("saved search restoration", () => {
  it("does not restore an old search after a drill-down was consumed", () => {
    expect(
      shouldRestoreSavedSearch({
        drillConsumed: true,
        hasDrillParams: true,
        restored: false,
      })
    ).toBe(false);
    expect(
      shouldRestoreSavedSearch({
        drillConsumed: true,
        hasDrillParams: false,
        restored: false,
      })
    ).toBe(false);
  });

  it("restores only once when there is no active drill-down", () => {
    expect(
      shouldRestoreSavedSearch({
        drillConsumed: false,
        hasDrillParams: false,
        restored: false,
      })
    ).toBe(true);
    expect(
      shouldRestoreSavedSearch({
        drillConsumed: false,
        hasDrillParams: false,
        restored: true,
      })
    ).toBe(false);
  });
});
