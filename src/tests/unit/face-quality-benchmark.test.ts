import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("face quality benchmark dataset validation", () => {
  it("rejects unlabeled images at the dataset root without waiting for a worker", () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "ai-image-manager-face-quality-")
    );
    temporaryDirectories.push(directory);
    fs.writeFileSync(path.join(directory, "face-1.jpg"), "not-an-image");

    const script = path.resolve("scripts/bench-face-quality.mjs");
    const result = spawnSync(process.execPath, [script, directory], {
      encoding: "utf8",
      timeout: 10_000,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("identity>/<images>");
    expect(result.error).toBeUndefined();
  });

  it("accepts a flat dataset when every image has an external label", () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "ai-image-manager-face-quality-labels-")
    );
    temporaryDirectories.push(directory);
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64"
    );
    for (const name of ["face-1.png", "face-2.png", "face-3.png"]) {
      fs.writeFileSync(path.join(directory, name), png);
    }
    const labelsFile = path.join(directory, "labels.json");
    fs.writeFileSync(
      labelsFile,
      JSON.stringify({
        "face-1.png": "alice",
        "face-2.png": "alice",
        "face-3.png": "bob",
      })
    );

    const script = path.resolve("scripts/bench-face-quality.mjs");
    const result = spawnSync(
      process.execPath,
      [script, directory, "--labels", labelsFile],
      {
        encoding: "utf8",
        timeout: 20_000,
      }
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("usable face embedding");
    expect(result.stderr).not.toContain("identity>/<images>");
    expect(result.error).toBeUndefined();
  });
});
