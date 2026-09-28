import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  selectOldObjects,
  validateOldPlan,
} from "../../../scripts/release-old-package-cleanup.mjs";

const plan = JSON.parse(
  fs.readFileSync("scripts/release/old-release-cleanup-plan.json", "utf8")
);
const groups = (objects) => ({ old: { objects } });

describe("approved old release cleanup", () => {
  it("binds deletion to the nine reviewed objects and exact total size", () => {
    expect(() => validateOldPlan(plan)).not.toThrow();
    expect(selectOldObjects(plan, groups(plan.objects), new Set())).toEqual(
      plan.objects
    );
    expect(selectOldObjects(plan, groups([]), new Set())).toEqual([]);
  });
  it("refuses to delete anything still referenced by either live feed", () => {
    expect(() =>
      selectOldObjects(
        plan,
        groups(plan.objects),
        new Set([plan.objects[0].key])
      )
    ).toThrow("references");
  });
  it.each(["etag", "lastModified", "size"])("refuses changed %s", (field) => {
    const objects = structuredClone(plan.objects);
    objects[0][field] = field === "size" ? 123 : "changed";
    expect(() => selectOldObjects(plan, groups(objects), new Set())).toThrow(
      "changed"
    );
  });
  it.each([
    "records.csv",
    "records.xlsx",
    "Temp/package.nupkg",
    "../package.nupkg",
  ])("protects %s", (suffix) => {
    const unsafe = structuredClone(plan);
    unsafe.objects[0].key = `ai-image-manager/downloads/2.1.0/${suffix}`;
    expect(() => validateOldPlan(unsafe)).toThrow();
  });
  it("rejects current version paths and preserves unrelated listed objects", () => {
    const unsafe = structuredClone(plan);
    unsafe.objects[0].key =
      "ai-image-manager/updates/win32/x64/stable/ai-image-manager-2.2.0-full.nupkg";
    expect(() => validateOldPlan(unsafe)).toThrow();
    expect(
      selectOldObjects(
        plan,
        groups([...plan.objects, unsafe.objects[0]]),
        new Set()
      )
    ).toEqual(plan.objects);
  });
});
