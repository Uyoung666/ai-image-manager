import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ORIGIN_BACKFILL_RE =
  /WHEN `confidence` IS NULL THEN 'manual'[\s\S]*ELSE 'auto'/;
const CONFIRMATION_BACKFILL_RE =
  /WHEN `confidence` IS NULL THEN 1[\s\S]*ELSE 0/;

describe("migration journal", () => {
  it("keeps migration timestamps strictly increasing", () => {
    const journal = JSON.parse(
      fs.readFileSync(
        path.join(process.cwd(), "drizzle", "meta", "_journal.json"),
        "utf8"
      )
    ) as { entries: Array<{ tag: string; when: number }> };

    for (let index = 1; index < journal.entries.length; index += 1) {
      const previous = journal.entries[index - 1];
      const current = journal.entries[index];
      expect(
        current.when,
        `${current.tag} must be newer than ${previous.tag}`
      ).toBeGreaterThan(previous.when);
    }
  });

  it("backfills manual and automatic tag provenance deterministically", () => {
    const migration = fs.readFileSync(
      path.join(process.cwd(), "drizzle", "0036_add_photo_tag_provenance.sql"),
      "utf8"
    );

    expect(migration).toContain("`origin` text DEFAULT 'manual' NOT NULL");
    expect(migration).toContain("`user_confirmed` integer DEFAULT 0 NOT NULL");
    expect(migration).toMatch(ORIGIN_BACKFILL_RE);
    expect(migration).toMatch(CONFIRMATION_BACKFILL_RE);
  });

  it("creates durable photo view and wander exposure counters", () => {
    const migration = fs.readFileSync(
      path.join(process.cwd(), "drizzle", "0042_add_photo_view_stats.sql"),
      "utf8"
    );

    expect(migration).toContain("CREATE TABLE `photo_view_stats`");
    expect(migration).toContain("`view_count` integer DEFAULT 0 NOT NULL");
    expect(migration).toContain(
      "`wander_shown_count` integer DEFAULT 0 NOT NULL"
    );
    expect(migration).toContain("ON DELETE cascade");
  });
});
