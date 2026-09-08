import { describe, expect, it } from "vitest";
import {
  containsPotentialSensitiveData,
  DiagnosticSanitizer,
  sanitizeRendererRoute,
} from "@/services/diagnostics/sanitizer";

describe("diagnostic sanitizer", () => {
  it("sanitizes decoded JSON fields while preserving stack lines and error codes", () => {
    const sanitizer = new DiagnosticSanitizer();
    const result = JSON.parse(
      sanitizer.sanitizeJson({
        password: 'private"escaped-secret',
        filename: "C:/Users/Alice/Pictures/private.jpg",
        code: "ORT_INIT_FAILED",
        stack:
          "Error: failed\n at initialize (D:\\repo\\src\\services\\indexer.ts:42:8)\n at retry (D:\\repo\\src\\main.ts:12:4)",
      })
    );
    expect(result.password).toBe("<REDACTED>");
    expect(result.code).toBe("ORT_INIT_FAILED");
    expect(result.stack).toContain("src/services/indexer.ts:42:8");
    expect(result.stack).toContain("src/main.ts:12:4");
    expect(JSON.stringify(result)).not.toContain("Alice");
    expect(JSON.stringify(result)).not.toContain("escaped-secret");
    expect(containsPotentialSensitiveData("C:/Users/Alice/private")).toBe(true);
  });
  it("accepts redacted URLs and spaced credentials without hiding real leaks", () => {
    const sanitizer = new DiagnosticSanitizer();
    const safe = sanitizer.sanitize(
      'Download failed https://models.example/model; token = "secret"'
    );
    expect(containsPotentialSensitiveData(safe)).toBe(false);
    expect(containsPotentialSensitiveData('token = "<REDACTED>"')).toBe(false);
    expect(containsPotentialSensitiveData('token = "secret"')).toBe(true);
    expect(containsPotentialSensitiveData("https://<HOST_1>/private")).toBe(
      true
    );
  });

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
    expect(
      sanitizer.sanitize(
        "at load (file:///C:/Users/Alice/app.asar/.vite/build/main.js:42:8)"
      )
    ).toContain(".vite/build/main.js:42:8");
  });

  it("redacts machine identity and keeps structured JSON valid", () => {
    const sanitizer = new DiagnosticSanitizer();
    const result = sanitizer.sanitize(
      JSON.stringify({
        hostname: "LIUYAN",
        proxy: "http://alice:secret@proxy.example/private",
        username: "Alice",
      })
    );
    const parsed = JSON.parse(result) as Record<string, string>;

    expect(parsed.hostname).toBe("<REDACTED>");
    expect(parsed.proxy).toBe("<REDACTED>");
    expect(parsed.username).toBe("<REDACTED>");
    expect(result).not.toContain("LIUYAN");
    expect(result).not.toContain("Alice");
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
    expect(containsPotentialSensitiveData('{"hostname":"LIUYAN"}')).toBe(true);
    expect(containsPotentialSensitiveData('{"hostname":"<REDACTED>"}')).toBe(
      false
    );
  });
});
