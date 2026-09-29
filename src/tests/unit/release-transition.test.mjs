// biome-ignore-all lint/suspicious/useAwait: fake COS methods model async SDK calls.

import { describe, expect, it } from "vitest";
import {
  formatReleases,
  parseReleases,
} from "../../../scripts/release/squirrel.mjs";
import {
  assertTransitionAuthorization,
  buildTransitionFeed,
  writeTransitionPointer,
} from "../../../scripts/release/transition-cos-to-github.mjs";

const oldEntries = [
  {
    hash: "1".repeat(40),
    filename: "ai-image-manager-2.1.0-full.nupkg",
    size: 100,
  },
  {
    hash: "2".repeat(40),
    filename: "ai-image-manager-2.2.0-delta.nupkg",
    size: 10,
  },
  {
    hash: "3".repeat(40),
    filename: "ai-image-manager-2.2.0-full.nupkg",
    size: 100,
  },
];

const targetEntries = [
  {
    hash: "4".repeat(40),
    filename: "ai-image-manager-2.2.1-delta.nupkg",
    size: 11,
    isDelta: true,
    isFull: false,
  },
  {
    hash: "5".repeat(40),
    filename: "ai-image-manager-2.2.1-full.nupkg",
    size: 101,
    isDelta: false,
    isFull: true,
  },
];
const NEWER_PATTERN = /newer/;
const DIFFERS_PATTERN = /differs/;
const CONFIRMATION_PATTERN = /exact confirmation/;

describe("COS to GitHub transition feed", () => {
  it("pins the historical chain and appends the target delta/full pair", () => {
    const result = buildTransitionFeed(
      formatReleases(oldEntries),
      targetEntries
    );
    const entries = parseReleases(result.text);
    expect(entries).toHaveLength(5);
    expect(entries.map((entry) => entry.filename)).toEqual([
      ...oldEntries.map((entry) => entry.filename),
      ...targetEntries.map((entry) => entry.filename),
    ]);
    expect(
      entries.every((entry) =>
        entry.url?.startsWith(
          "https://github.com/Uyoung666/ai-image-manager/releases/download/v"
        )
      )
    ).toBe(true);
  });

  it("is byte-for-byte idempotent after the pointer has been switched", () => {
    const first = buildTransitionFeed(
      formatReleases(oldEntries),
      targetEntries
    );
    const second = buildTransitionFeed(first.text, targetEntries);
    expect(second.text).toBe(first.text);
  });

  it("rejects a newer package or a conflicting target hash", () => {
    expect(() =>
      buildTransitionFeed(
        formatReleases([
          ...oldEntries,
          {
            hash: "6".repeat(40),
            filename: "ai-image-manager-2.3.0-full.nupkg",
            size: 102,
          },
        ]),
        targetEntries
      )
    ).toThrow(NEWER_PATTERN);
    const switched = buildTransitionFeed(
      formatReleases(oldEntries),
      targetEntries
    );
    expect(() =>
      buildTransitionFeed(switched.text, [
        { ...targetEntries[0], hash: "f".repeat(40) },
        targetEntries[1],
      ])
    ).toThrow(DIFFERS_PATTERN);
  });
});
describe("COS transition authorization", () => {
  it("requires the exact one-time confirmation", () => {
    expect(() =>
      assertTransitionAuthorization({
        COS_TRANSITION_APPROVED: "1",
        TRANSITION_VERSION: "2.2.1",
        TRANSITION_CONFIRMATION: "wrong",
        GH_TOKEN: "test",
      })
    ).toThrow(CONFIRMATION_PATTERN);
    expect(
      assertTransitionAuthorization({
        COS_TRANSITION_APPROVED: "1",
        TRANSITION_VERSION: "2.2.1",
        TRANSITION_CONFIRMATION: "SWITCH COS STABLE TO GITHUB V2.2.1",
        GH_TOKEN: "test",
      })
    ).toEqual({
      repository: "Uyoung666/ai-image-manager",
      version: "2.2.1",
    });
  });

  it("uses a staged object and CopyObject when direct pointer overwrite is denied", async () => {
    const calls = [];
    const store = {
      async putMutableBytes() {
        calls.push("putMutableBytes");
        throw Object.assign(new Error("Access Denied"), { statusCode: 403 });
      },
      async putBytes(key, bytes) {
        calls.push(["putBytes", key, Buffer.from(bytes).toString()]);
      },
      async copy(source, destination) {
        calls.push(["copy", source, destination]);
      },
      async delete(key) {
        calls.push(["delete", key]);
      },
    };
    const result = await writeTransitionPointer(
      store,
      "ai-image-manager/updates/win32/x64/stable/RELEASES",
      Buffer.from("feed"),
      { sha256: "a".repeat(64), size: 4 }
    );
    expect(result.method).toBe("copy");
    expect(calls[0]).toBe("putMutableBytes");
    expect(calls[1][0]).toBe("putBytes");
    expect(calls[2][0]).toBe("copy");
    expect(calls[3][0]).toBe("delete");
  });
});
