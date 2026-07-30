/** @vitest-environment node */
import type Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { repairPhotoTagProvenanceSchema } from "@/db";

function sqliteWithColumns(columnNames: string[]): {
  exec: ReturnType<typeof vi.fn>;
  sqlite: Database.Database;
} {
  const exec = vi.fn();
  const sqlite = {
    exec,
    prepare: vi.fn(() => ({
      all: () => columnNames.map((name) => ({ name })),
    })),
    transaction: vi.fn((callback: () => void) => callback),
  } as unknown as Database.Database;
  return { exec, sqlite };
}

describe("photo tag provenance schema repair", () => {
  it("adds and backfills both missing provenance columns", () => {
    const { exec, sqlite } = sqliteWithColumns([
      "id",
      "photo_id",
      "tag_id",
      "confidence",
      "is_confirmed",
    ]);

    expect(repairPhotoTagProvenanceSchema(sqlite)).toEqual({
      addedOrigin: true,
      addedUserConfirmed: true,
    });
    expect(exec.mock.calls.map(([sql]) => sql)).toEqual([
      expect.stringContaining("ALTER TABLE photo_tags ADD origin"),
      expect.stringContaining("SET origin = CASE"),
      expect.stringContaining("ALTER TABLE photo_tags ADD user_confirmed"),
      expect.stringContaining("SET user_confirmed = CASE"),
    ]);
    expect(exec.mock.calls.flat().join("\n")).not.toContain("DELETE");
    expect(exec.mock.calls.flat().join("\n")).not.toContain("DROP");
  });

  it("is idempotent when both columns already exist", () => {
    const { exec, sqlite } = sqliteWithColumns([
      "id",
      "photo_id",
      "tag_id",
      "confidence",
      "is_confirmed",
      "origin",
      "user_confirmed",
    ]);

    expect(repairPhotoTagProvenanceSchema(sqlite)).toEqual({
      addedOrigin: false,
      addedUserConfirmed: false,
    });
    expect(exec).not.toHaveBeenCalled();
  });
});
