// @vitest-environment node
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import electron from "electron";
import { expect, it, vi } from "vitest";
import { allowProductProfileWrites } from "../../../scripts/release/update-product-gate.mjs";
import { TestRuntime } from "../helpers/test-runtime";

vi.unmock("electron");

it.skipIf(process.platform !== "win32")(
  "repairs copied profile ACLs for the real restricted token, including existing logs, settings and database files",
  async () => {
    const runtime = new TestRuntime("product-profile-permissions");
    const profile = path.join(runtime.root, "control-profile");
    try {
      await fs.mkdir(path.join(profile, "logs"), { recursive: true });
      const files = ["logs/startup.log", "update-state.json", "album.db"];
      for (const name of files) {
        await fs.writeFile(path.join(profile, name), "retained data\n");
      }
      // Reproduce copied files owned/granted to Administrators while the
      // standard token has only user Read access. No explicit deny is needed.
      const setup = `$ErrorActionPreference='Stop'; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; foreach($file in ${files.map((name) => `'${path.join(profile, name).replaceAll("'", "''")}'`).join(",")}) { $acl=[IO.File]::GetAccessControl($file); $acl.SetAccessRuleProtection($true,$false); foreach($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleSpecific($rule) }; $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'Read','Allow')); $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'),'FullControl','Allow')); [IO.File]::SetAccessControl($file,$acl) }`;
      const configured = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(setup, "utf16le").toString("base64"),
        ],
        { windowsHide: true, encoding: "utf8", timeout: 10_000 }
      );
      expect(configured.error).toBeUndefined();
      expect(configured.status, configured.stderr).toBe(0);
      const probe = path.join(runtime.root, "probe.cjs");
      const resultFile = path.join(runtime.root, "result.json");
      await fs.writeFile(
        probe,
        `const fs=require('node:fs'); try {
for(const file of ${JSON.stringify(files.map((name) => path.join(profile, name)))}) fs.appendFileSync(file,'standard user write\\n');
fs.writeFileSync(${JSON.stringify(resultFile)},JSON.stringify({status:'passed'}));
} catch(error) { fs.writeFileSync(${JSON.stringify(resultFile)},JSON.stringify({status:'blocked',code:error.code,message:error.message})); process.exitCode=9; }`
      );
      const runProbe = () =>
        spawnSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            path.resolve("scripts/release/start-standard-user.ps1"),
          ],
          {
            env: {
              ...process.env,
              ELECTRON_RUN_AS_NODE: "1",
              AIM_STANDARD_VERIFY_PID: undefined,
              AIM_STANDARD_MSI_ROOT: undefined,
              AIM_STANDARD_EXECUTABLE: electron,
              AIM_STANDARD_ARGUMENTS: `"${probe}"`,
            },
            windowsHide: true,
            encoding: "utf8",
            timeout: 15_000,
          }
        );
      const blocked = runProbe();
      expect(blocked.error).toBeUndefined();
      const denied = JSON.parse(await fs.readFile(resultFile, "utf8"));
      expect(denied).toMatchObject({ status: "blocked", code: "EPERM" });
      await allowProductProfileWrites(profile);
      const writable = runProbe();
      expect(writable.error).toBeUndefined();
      expect(writable.status, writable.stderr).toBe(0);
      expect(JSON.parse(await fs.readFile(resultFile, "utf8"))).toEqual({
        status: "passed",
      });
      for (const name of files) {
        expect(await fs.readFile(path.join(profile, name), "utf8")).toBe(
          "retained data\nstandard user write\n"
        );
      }
    } finally {
      // Also restore cleanup access if an assertion fails before the repair.
      await allowProductProfileWrites(profile);
      runtime.cleanup();
    }
  },
  40_000
);

it.skipIf(process.platform !== "win32")(
  "refuses profile ACL changes outside the isolated control",
  async () => {
    await expect(allowProductProfileWrites(process.cwd())).rejects.toThrow(
      "escaped the isolated control"
    );
  }
);
