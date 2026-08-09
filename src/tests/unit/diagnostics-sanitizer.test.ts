import { describe, expect, it } from "vitest";
import {
  containsPotentialSensitiveData,
  DiagnosticSanitizer,
  sanitizeRendererRoute,
} from "@/services/diagnostics/sanitizer";

describe("diagnostic sanitizer", () => {
  it("redacts paths, media filenames, private hosts, queries and credentials", () => {
    const sanitizer = new DiagnosticSanitizer();
    const input = [
      String.raw`path=C:\Users\Alice\Pictures\Family Trip\IMG_0001.jpg`,
      String.raw`backup=\\NAS\Private Photos\IMG_0001.jpg`,
      "query=family password=hunter2 token=secret-123",
      "https://alice:password@private.example/photos?id=123",
      "attachment=private-notes.pdf",
    ].join("\n");

    const result = sanitizer.sanitize(input);

    expect(result).not.toContain("Alice");
    expect(result).not.toContain("Family Trip");
    expect(result).not.toContain("IMG_0001");
    expect(result).not.toContain("family");
    expect(result).not.toContain("hunter2");
    expect(result).not.toContain("secret-123");
    expect(result).not.toContain("private.example");
    expect(result).not.toContain("private-notes");
    expect(result).toContain("<REDACTED>");
    expect(result).toContain("<PATH_");
    expect(result).toContain("https://<HOST_");
  });

  it("removes queries and dynamic ids from renderer routes", () => {
    expect(sanitizeRendererRoute("/albums/42?tab=private")).toBe("/albums/:id");
    expect(
      sanitizeRendererRoute(
        "/people/5d4d8cb8-8f52-42ea-bb7a-9dd88c67e123/details"
      )
    ).toBe("/people/:id/details");
  });

  it("keeps app source locations and uses stable tokens within one bundle", () => {
    const sanitizer = new DiagnosticSanitizer();
    const source = String.raw`at run (D:\repo\src\services\indexer.ts:42:8)`;
    const repeated = String.raw`C:\Users\Alice\Pictures\same-folder`;
    const result = sanitizer.sanitize(`${source}\n${repeated}\n${repeated}`);

    expect(result).toContain("src/services/indexer.ts:42:8");
    const tokens = result.match(/<PATH_\d+>/g) ?? [];
    expect(tokens).toHaveLength(2);
    expect(tokens[0]).toBe(tokens[1]);
  });

  it("detects a secret that remains after sanitization", () => {
    expect(containsPotentialSensitiveData("token=still-visible")).toBe(true);
    expect(containsPotentialSensitiveData("token=<REDACTED>")).toBe(false);
    expect(
      containsPotentialSensitiveData("safe text", [String.raw`C:\Users\Alice`])
    ).toBe(false);
    expect(
      containsPotentialSensitiveData(String.raw`C:\Users\Alice\photo.jpg`, [
        String.raw`C:\Users\Alice`,
      ])
    ).toBe(true);
    expect(
      containsPotentialSensitiveData("https://private.example/photos?id=1")
    ).toBe(true);
    expect(containsPotentialSensitiveData("https://github.com")).toBe(false);
  });
});
