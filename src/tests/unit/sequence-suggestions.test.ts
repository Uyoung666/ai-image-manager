/** @vitest-environment node */
import { call } from "@orpc/server";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  advancedExifData,
  exifData,
  folders,
  photoSequenceMembers,
  photoSequenceSuggestions,
  photoSequences,
  photos,
} from "@/db/schema";
import {
  acceptSequenceSuggestion as acceptSuggestionHandler,
  createSequence,
  mergeSequences,
  splitSequence,
  updateSequenceMembersInPlace,
} from "@/ipc/photos/handlers/sequences";
import {
  cleanupDeletedPhotoSequenceMembers,
  getPhotoSequenceRevision,
  previewPhotoSequences,
  rebuildPhotoSequences,
} from "@/services/photo-sequences";
import {
  acceptSequenceSuggestion,
  refreshSequenceSuggestions,
} from "@/services/sequence-suggestions";
import { setSetting } from "@/services/settings-manager";
import { normalizeSequenceDetectionSettings } from "@/types/sequence-detection-settings";

const state = vi.hoisted(() => ({ db: undefined as unknown, send: vi.fn() }));
vi.mock("@/db", () => ({ getDatabase: () => state.db }));
vi.mock("electron", () => ({
  app: { getPath: () => ".test-runtime", getAppPath: () => process.cwd() },
  BrowserWindow: {
    getAllWindows: () => [
      { isDestroyed: () => false, webContents: { send: state.send } },
    ],
  },
}));
let sqlite: Database.Database;
let db: ReturnType<typeof drizzle>;
const START = 1_700_000_000_000;

function segment(
  id: number,
  offset: number,
  folderId = 2,
  camera = "Camera A"
) {
  const ids: number[] = [];
  for (let index = 0; index < 6; index++) {
    const photoId = id * 10 + index;
    const capturedAt = START + offset + index * 5000;
    ids.push(photoId);
    db.insert(photos)
      .values({
        id: photoId,
        path: `C:/fixture/${photoId}.jpg`,
        filename: `${photoId}.jpg`,
        folderId,
        phash: "0000000000000000",
        isIndexed: true,
      })
      .run();
    db.insert(exifData)
      .values({
        photoId,
        cameraModel: camera,
        lensModel: "Lens A",
        dateTaken: capturedAt,
      })
      .run();
    db.insert(advancedExifData)
      .values({
        photoId,
        status: "ready",
        parserVersion: 1,
        normalizedJson: JSON.stringify({
          capture: { captureTimestampMs: capturedAt },
        }),
      })
      .run();
  }
  db.insert(photoSequences)
    .values({
      id,
      folderId,
      type: "timelapse",
      representativePhotoId: ids[0],
      startedAt: START + offset,
      endedAt: START + offset + 25_000,
      frameCount: 6,
    })
    .run();
  db.insert(photoSequenceMembers)
    .values(
      ids.map((photoId, position) => ({ photoId, position, sequenceId: id }))
    )
    .run();
  return ids;
}

beforeEach(() => {
  sqlite = new Database(":memory:");
  db = drizzle(sqlite);
  migrate(db, { migrationsFolder: "drizzle" });
  sqlite.pragma("foreign_keys = ON");
  state.db = db;
  state.send.mockClear();
  db.insert(folders)
    .values([
      { id: 1, path: "C:/fixture", displayName: "parent" },
      { id: 2, path: "C:/fixture/child", displayName: "child", parentId: 1 },
      { id: 3, path: "D:/other", displayName: "other" },
    ])
    .run();
});
afterEach(() => sqlite.close());

describe("sequence suggestion lifecycle", () => {
  it("serializes concurrent acceptance through IPC without duplicate writes", async () => {
    segment(1, 0);
    segment(2, 100_000);
    const [suggestion] = refreshSequenceSuggestions();
    const results = await Promise.all([
      call(acceptSuggestionHandler, { suggestionId: suggestion.id }),
      call(acceptSuggestionHandler, { suggestionId: suggestion.id }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([
      "merged",
      "stale",
    ]);
    expect(db.select().from(photoSequences).all()).toHaveLength(1);
    expect(state.send).toHaveBeenCalledTimes(1);
  });
  it("shows both full segments under a parent folder and consumes a suggestion once", () => {
    segment(1, 0);
    segment(2, 100_000);
    const [suggestion] = refreshSequenceSuggestions(1);
    expect(suggestion.first.frameCount).toBe(6);
    expect(suggestion.first.firstPhoto.filename).toBe("10.jpg");
    expect(suggestion.second.lastPhoto.filename).toBe("25.jpg");
    const result = acceptSequenceSuggestion(suggestion.id);
    expect(result.status).toBe("merged");
    expect(refreshSequenceSuggestions(1)).toEqual([]);
    expect(acceptSequenceSuggestion(suggestion.id).status).toBe("stale");
    expect(db.select().from(photoSequences).all()).toHaveLength(1);
    expect(db.select().from(photoSequenceSuggestions).all()).toHaveLength(0);
    expect(state.send).toHaveBeenCalledTimes(1);
    expect(state.send.mock.calls[0][1]).toMatchObject({
      revision: result.revision,
      deletedSequenceIds: [1, 2],
    });
  });
  it("replaces A-B and B-C with merged-AB to C", () => {
    segment(1, 0);
    segment(2, 100_000);
    segment(3, 200_000);
    const [first, second] = refreshSequenceSuggestions();
    const result = acceptSequenceSuggestion(first.id);
    expect(result.status).toBe("merged");
    const next = refreshSequenceSuggestions();
    expect(next).toHaveLength(1);
    expect(next[0].first.frameCount).toBe(12);
    expect(next[0].secondSequenceId).toBe(3);
    expect(acceptSequenceSuggestion(second.id).status).toBe("stale");
  });
  it("cleans invalid advice after boundary metadata or settings change", () => {
    segment(1, 0);
    segment(2, 100_000);
    const [suggestion] = refreshSequenceSuggestions();
    sqlite
      .prepare("UPDATE photos SET phash='ffffffffffffffff' WHERE id=20")
      .run();
    expect(acceptSequenceSuggestion(suggestion.id).status).toBe("stale");
    expect(refreshSequenceSuggestions()).toEqual([]);
    expect(state.send).not.toHaveBeenCalled();
    sqlite
      .prepare("UPDATE photos SET phash='0000000000000000' WHERE id=20")
      .run();
    expect(refreshSequenceSuggestions()).toHaveLength(1);
    setSetting(
      "sequence.detection.settings",
      JSON.stringify({ continuationWindowMs: 60_000 })
    );
    expect(refreshSequenceSuggestions()).toEqual([]);
    expect(db.select().from(photoSequenceSuggestions).all()).toHaveLength(0);
  });
  it("does not bridge unknown or different devices, folders, or deleted members", () => {
    segment(1, 0);
    segment(2, 100_000, 2, "Camera B");
    segment(3, 200_000, 3);
    expect(refreshSequenceSuggestions()).toEqual([]);
    sqlite.prepare("UPDATE exif_data SET camera_model=NULL").run();
    expect(refreshSequenceSuggestions()).toEqual([]);
  });
  it("uses a configured missing-frame boundary rather than a fixed multiplier", () => {
    segment(1, 0);
    segment(2, 35_000);
    expect(refreshSequenceSuggestions()).toEqual([]);
    setSetting(
      "sequence.detection.settings",
      JSON.stringify({ maxMissingFrames: 0 })
    );
    expect(refreshSequenceSuggestions()).toHaveLength(1);
  });
  it("rejects a suggestion after a member was deleted without cleanup", () => {
    segment(1, 0);
    segment(2, 100_000);
    const [suggestion] = refreshSequenceSuggestions();
    sqlite.prepare("UPDATE photos SET deleted_at=1 WHERE id=20").run();
    expect(acceptSequenceSuggestion(suggestion.id).status).toBe("stale");
    expect(db.select().from(photoSequences).all()).toHaveLength(2);
  });
  it("rolls back both deletions if creation fails and never broadcasts success", () => {
    segment(1, 0);
    segment(2, 100_000);
    const [suggestion] = refreshSequenceSuggestions();
    sqlite.exec(
      "CREATE TRIGGER reject_merge BEFORE INSERT ON photo_sequences BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;"
    );
    expect(() => acceptSequenceSuggestion(suggestion.id)).toThrow(
      "fixture failure"
    );
    expect(db.select().from(photoSequences).all()).toHaveLength(2);
    expect(refreshSequenceSuggestions()[0].id).toBe(suggestion.id);
    expect(state.send).not.toHaveBeenCalled();
  });
});

describe("sequence identity, order and rebuild consistency", () => {
  it("preserves unchanged IDs and matches the parent-scope preview", () => {
    segment(1, 0);
    segment(2, 100_000, 3);
    const preview = previewPhotoSequences(1);
    const result = rebuildPhotoSequences(1);
    expect(preview.nextAutomatic).toBe(1);
    expect(result.nextAutomatic).toBe(preview.nextAutomatic);
    expect(
      db
        .select()
        .from(photoSequences)
        .all()
        .map((sequence) => sequence.id)
    ).toEqual([1, 2]);
    expect(getPhotoSequenceRevision()).toBe(result.revision);
  });
  it("keeps manual order through splitting while times remain chronological", async () => {
    const ids = segment(1, 0);
    const order = [...ids].reverse();
    db.transaction(() => updateSequenceMembersInPlace(db, 1, order));
    expect(db.select().from(photoSequences).get()).toMatchObject({
      startedAt: START,
      endedAt: START + 25_000,
    });
    const result = await call(splitSequence, { id: 1, position: 3 });
    expect(
      result.ids.flatMap((id) =>
        sqlite
          .prepare(
            "SELECT photo_id FROM photo_sequence_members WHERE sequence_id=? ORDER BY position"
          )
          .all(id)
          .map((row) => (row as { photo_id: number }).photo_id)
      )
    ).toEqual(order);
  });
  it("repairs boundary times, representative and contiguous member positions", () => {
    segment(1, 0);
    sqlite.prepare("UPDATE photos SET deleted_at=1 WHERE id IN (10,15)").run();
    db.transaction(() => cleanupDeletedPhotoSequenceMembers(db));
    expect(db.select().from(photoSequences).get()).toMatchObject({
      frameCount: 4,
      representativePhotoId: 11,
      startedAt: START + 5000,
      endedAt: START + 20_000,
    });
    expect(
      db
        .select()
        .from(photoSequenceMembers)
        .all()
        .map((member) => member.position)
    ).toEqual([0, 1, 2, 3]);
  });
  it("rejects duplicate IDs, claimed members and invalid creation atomically", async () => {
    const ids = segment(1, 0);
    await expect(call(mergeSequences, { sequenceIds: [1, 1] })).rejects.toThrow(
      "distinct"
    );
    await expect(
      call(createSequence, { type: "burst", photoIds: [ids[0], ids[1]] })
    ).rejects.toThrow("unclaimed");
    await expect(
      call(createSequence, { type: "burst", photoIds: [ids[0], 999] })
    ).rejects.toThrow("active");
    expect(db.select().from(photoSequences).all()).toHaveLength(1);
    expect(state.send).not.toHaveBeenCalled();
  });
  it("normalizes custom and invalid settings without NaN or reversed ranges", () => {
    expect(
      normalizeSequenceDetectionSettings({
        preset: "custom",
        timelapseMinFrames: 5.8,
        rhythmTolerance: Number.NaN,
        maxMissingFrames: 1.8,
        minTimelapseGapMs: 10_000,
        maxTimelapseGapMs: 2000,
      })
    ).toMatchObject({
      preset: "custom",
      timelapseMinFrames: 6,
      rhythmTolerance: 0.15,
      maxMissingFrames: 2,
      minTimelapseGapMs: 10_000,
      maxTimelapseGapMs: 10_000,
    });
  });
});
