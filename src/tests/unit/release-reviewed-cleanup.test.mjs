import { describe, expect, it } from "vitest";
import {
  assertCompletedRuns,
  listMultipart,
  selectAbandonedUploads,
  selectReviewedObjects,
} from "../../../scripts/release-reviewed-cleanup.mjs";

const prefix = "ai-image-manager/updates/win32/x64/testing/runs/10/";
const object = {
  key: `${prefix}package.nupkg`,
  size: 42,
  etag: "hash",
  lastModified: "2026-01-01",
};
const groups = (objects) => ({ testing: { objects } });
const completed = {
  id: 10,
  path: ".github/workflows/publish.yaml",
  status: "completed",
};

describe("reviewed release cleanup", () => {
  it("requires a known completed release run and no concurrent recovery", () => {
    expect(() => assertCompletedRuns([completed], ["10"])).not.toThrow();
    expect(() => assertCompletedRuns([completed], ["11"])).toThrow();
    expect(() => assertCompletedRuns([completed], [])).toThrow();
    expect(() =>
      assertCompletedRuns([{ ...completed, status: "in_progress" }], ["10"])
    ).toThrow();
    expect(() =>
      assertCompletedRuns(
        [
          completed,
          {
            id: 11,
            path: ".github/workflows/recover-release-candidate.yaml",
            status: "queued",
          },
        ],
        ["10"]
      )
    ).toThrow();
  });

  it("selects only exact reviewed keys and tolerates already absent objects", () => {
    const unrelated = {
      ...object,
      key: "ai-image-manager/updates/win32/x64/stable/package.nupkg",
    };
    expect(
      selectReviewedObjects(groups([object]), groups([object, unrelated]), [
        prefix,
      ])
    ).toEqual([object]);
    expect(
      selectReviewedObjects(groups([object]), groups([]), [prefix])
    ).toEqual([]);
  });

  it.each([
    { ...object, etag: "replacement" },
    { ...object, size: 43 },
    { ...object, lastModified: "2026-02-01" },
    { ...object, key: `${prefix}new.nupkg` },
  ])("refuses changed or newly added objects before deletion", (changed) => {
    expect(() =>
      selectReviewedObjects(groups([object]), groups([changed]), [prefix])
    ).toThrow();
  });

  it.each([
    "records.csv",
    "records.XLSX",
    "Temp/file.nupkg",
    "nested/temp/file.nupkg",
    "unrelated.txt",
  ])("protects user content %s", (name) => {
    const protectedObject = { ...object, key: prefix + name };
    expect(() =>
      selectReviewedObjects(
        groups([protectedObject]),
        groups([protectedObject]),
        [prefix]
      )
    ).toThrow();
  });

  it("only selects old uploads in reviewed temporary prefixes", () => {
    const old = { key: object.key, initiated: "2026-01-01", uploadId: "old" };
    const uploads = [
      old,
      { ...old, initiated: "2026-01-03T11:00:00Z" },
      { ...old, key: "ai-image-manager/downloads/2.2.0/package.nupkg" },
      { ...old, key: `${prefix}Temp/package.nupkg` },
      { ...old, initiated: "invalid" },
    ];
    expect(
      selectAbandonedUploads(
        uploads,
        [prefix],
        Date.parse("2026-01-03T12:00:00Z")
      )
    ).toEqual([old]);
  });

  it("counts every upload and part page without downloading file contents", async () => {
    const calls = [];
    const store = {
      bucket: "bucket",
      region: "region",
      requestOptions: () => ({ retryCount: 0 }),
      client: {
        multipartList(params, callback) {
          calls.push(params);
          callback(
            null,
            params.KeyMarker
              ? { Upload: [{ Key: "second", UploadId: "2" }] }
              : {
                  Upload: [{ Key: "first", UploadId: "1" }],
                  IsTruncated: "true",
                  NextKeyMarker: "first",
                  NextUploadIdMarker: "1",
                }
          );
        },
        multipartListPart(params, callback) {
          callback(
            null,
            params.PartNumberMarker
              ? { Part: [{ Size: "7" }] }
              : {
                  Part: [{ Size: "5" }],
                  IsTruncated: "true",
                  NextPartNumberMarker: "1",
                }
          );
        },
      },
    };
    const uploads = await listMultipart(store, "app/");
    expect(uploads.map((item) => item.size)).toEqual([12, 12]);
    expect(calls[1]).toMatchObject({
      KeyMarker: "first",
      UploadIdMarker: "1",
      Prefix: "app/",
    });
  });
});
