/** @vitest-environment node */
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { extractArchive } from "../../../scripts/setup-wix-toolset.mjs";
import { TestRuntime } from "../helpers/test-runtime";

const { ZipArchive } = createRequire(import.meta.url)("archiver");

afterEach(() => vi.unstubAllEnvs());

it.skipIf(process.platform !== "win32")(
  "extracts with the Windows module when another Archive module is inherited",
  async () => {
    const runtime = new TestRuntime("wix-archive-extraction");
    try {
      const archive = path.join(runtime.root, "tools.zip");
      const output = fs.createWriteStream(archive);
      const closed = once(output, "close");
      const zip = new ZipArchive();
      zip.pipe(output);
      zip.append("verified tool payload", { name: "probe.txt" });
      await zip.finalize();
      await closed;
      const destination = path.join(runtime.root, "extracted");
      const foreignModule = path.join(
        runtime.root,
        "foreign-modules",
        "Microsoft.PowerShell.Archive",
        "99.0.0"
      );
      fs.mkdirSync(foreignModule, { recursive: true });
      fs.writeFileSync(
        path.join(foreignModule, "Microsoft.PowerShell.Archive.psd1"),
        "@{RootModule='Archive.psm1';ModuleVersion='99.0.0';FunctionsToExport=@('Expand-Archive')}"
      );
      fs.writeFileSync(
        path.join(foreignModule, "Archive.psm1"),
        "function Expand-Archive { throw 'Incompatible inherited Archive module' }"
      );
      vi.stubEnv(
        "PSModulePath",
        [path.join(runtime.root, "foreign-modules"), process.env.PSModulePath]
          .filter(Boolean)
          .join(path.delimiter)
      );
      const fixture = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "(Get-Command Expand-Archive).Module.ModuleBase",
        ],
        {
          encoding: "utf8",
          windowsHide: true,
          env: { ...process.env },
        }
      );
      expect(fixture.error).toBeUndefined();
      expect(fixture.status, fixture.stderr).toBe(0);
      expect(fixture.stdout.trim()).toBe(foreignModule);

      extractArchive(archive, destination);
      expect(fs.readFileSync(path.join(destination, "probe.txt"), "utf8")).toBe(
        "verified tool payload"
      );
      fs.writeFileSync(path.join(destination, "probe.txt"), "stale payload");
      extractArchive(archive, destination);
      expect(fs.readFileSync(path.join(destination, "probe.txt"), "utf8")).toBe(
        "verified tool payload"
      );
    } finally {
      runtime.cleanup();
    }
  },
  30_000
);

it.skipIf(process.platform !== "win32")(
  "reports a failed extraction as a nonzero exit",
  () => {
    const runtime = new TestRuntime("wix-invalid-archive");
    try {
      const archive = path.join(runtime.root, "invalid.zip");
      fs.writeFileSync(archive, "not a ZIP archive");
      expect(() =>
        extractArchive(archive, path.join(runtime.root, "extracted"))
      ).toThrow("WiX extraction failed with exit code 1");
    } finally {
      runtime.cleanup();
    }
  },
  30_000
);
