import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

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
});
