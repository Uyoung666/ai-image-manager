// @vitest-environment node
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { finished } from "node:stream/promises";
import {
  createPackageWithOptions,
  extractFile,
  statFile,
} from "@electron/asar";
import { expect, it } from "vitest";
import { validateSmoke } from "../../../scripts/release/bundle.mjs";
import {
  installedTargetPath,
  repackTestSuccessorArchive,
} from "../../../scripts/release/update-product-gate.mjs";
import {
  certificatePowerShellScript,
  createProductUpdateProxy,
  isDisposableWindowsRunner,
  selectProductRequest,
} from "../../../scripts/release/update-product-proxy.mjs";
import { TestRuntime } from "../helpers/test-runtime";

const identity = {
  version: "2.2.7",
  tag: "v2.2.7",
  commit: "a".repeat(40),
  productUpdateGateRequired: true,
};
const hash = "b".repeat(64);

it.each([
  ["win32", "true", "github-hosted", true],
  ["win32", "true", "self-hosted", false],
  ["win32", "true", undefined, false],
  ["win32", undefined, "github-hosted", false],
  ["linux", "true", "github-hosted", false],
])("restricts test trust changes to disposable hosted Windows (%s, %s, %s)", (platform, actions, runner, allowed) => {
  expect(
    isDisposableWindowsRunner(platform, {
      GITHUB_ACTIONS: actions,
      RUNNER_ENVIRONMENT: runner,
    })
  ).toBe(allowed);
});

it.skipIf(process.platform !== "win32")(
  "initializes the certificate drive in a clean no-profile shell without auto-loading",
  () => {
    const script = `Import-Module Microsoft.PowerShell.Management; Remove-Module Microsoft.PowerShell.Security -ErrorAction SilentlyContinue; $PSModuleAutoLoadingPreference='None'; if(Get-PSDrive -Name Cert -ErrorAction SilentlyContinue) { throw 'Certificate provider fixture was not unloaded' }; ${certificatePowerShellScript("[Console]::Write((Get-PSDrive -Name Cert).Provider.Name)")}`;
    const result = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { windowsHide: true, timeout: 15_000, encoding: "utf8" }
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("Certificate");
  },
  20_000
);

it.skipIf(!isDisposableWindowsRunner(process.platform, process.env))(
  "starts and closes the trusted HTTPS proxy on a disposable Windows runner",
  async () => {
    const runtime = new TestRuntime("product-proxy-certificate");
    let proxy;
    try {
      proxy = await createProductUpdateProxy(runtime.root, identity, {});
      const response = await fetch(proxy.url);
      expect(response.status).toBe(403);
    } finally {
      await proxy?.close();
      runtime.cleanup();
    }
  },
  90_000
);
function direction(targetVersion) {
  const target = `C:\\Product\\app-${targetVersion}\\app.exe`;
  return {
    targetVersion,
    confirmed: true,
    dataRetained: "passed",
    secondLaunch: "passed",
    sourceExecutableSha256: hash,
    targetExecutableSha256: hash,
    packageSha256: hash,
    target,
    actualProcess: { pid: 1234, createdAt: "12345678", path: target },
  };
}
function evidence(kind) {
  return {
    kind,
    version: identity.version,
    commit: identity.commit,
    bundleSha256: hash,
    status: "passed",
    testSuccessorOnly: true,
    first: direction(identity.version),
    second: direction("2.2.8"),
  };
}
function smoke() {
  return {
    ...identity,
    schemaVersion: 4,
    bundleSha256: hash,
    setupSmoke: "passed",
    msiSmoke: "passed",
    msiSmokeMode: "upgrade",
    squirrelDeltaSmoke: "passed",
    productUpdate: "passed",
    productUpdateEvidence: [evidence("setup"), evidence("msi")],
  };
}
it("requires both installer types and both upgrade directions tied to the same candidate bytes", () => {
  expect(() => validateSmoke(smoke(), identity, hash)).not.toThrow();
  const mutations = [
    (value) => {
      value.productUpdateEvidence[0].first.targetExecutableSha256 = undefined;
      value.productUpdateEvidence[0].second.sourceExecutableSha256 = undefined;
    },
    (value) => {
      value.productUpdateEvidence[0].second.confirmed = "skipped";
    },
    (value) => {
      value.productUpdateEvidence[0].second.actualProcess = undefined;
    },
    (value) => {
      value.productUpdateEvidence.pop();
    },
    (value) => {
      value.productUpdateEvidence[0].second.confirmed = false;
    },
    (value) => {
      value.productUpdateEvidence[0].second.sourceExecutableSha256 = "other";
    },
    (value) => {
      value.productUpdateEvidence[1].commit = "other";
    },
    (value) => {
      value.productUpdateEvidence[1].bundleSha256 = "other";
    },
    (value) => {
      value.productUpdateEvidence[1].first.secondLaunch = "skipped";
    },
    (value) => {
      value.schemaVersion = 3;
    },
  ];
  for (const change of mutations) {
    const value = smoke();
    change(value);
    expect(() => validateSmoke(value, identity, hash)).toThrow();
  }
});
it("accepts reverified evidence for a resealed recovery bundle without changing candidate bytes", () => {
  const recoveredHash = "c".repeat(64);
  const recovered = { ...identity, productUpdateEvidenceBundleSha256: hash };
  expect(() =>
    validateSmoke(
      { ...smoke(), bundleSha256: recoveredHash },
      recovered,
      recoveredHash
    )
  ).not.toThrow();
  const wrong = smoke();
  wrong.productUpdateEvidence[0].second.sourceExecutableSha256 = "changed";
  expect(() =>
    validateSmoke(
      { ...wrong, bundleSha256: recoveredHash },
      recovered,
      recoveredHash
    )
  ).toThrow();
});
it("resolves both flat MSI and versioned Squirrel installation roots", () => {
  const root = path.resolve(".test-runtime", "root");
  const target = path.join(root, "app-2.2.8", "app.exe");
  expect(installedTargetPath(path.join(root, "app.exe"), "2.2.8")).toBe(target);
  expect(
    installedTargetPath(path.join(root, "app-2.2.7", "app.exe"), "2.2.8")
  ).toBe(target);
});
it("repackages pruned production ASARs while preserving native unpacking and application bytes", async () => {
  const runtime = new TestRuntime("successor-archive");
  // Tests run in Electron Node mode; disable transparent ASAR mounts for fixture I/O.
  const previousNoAsar = process.noAsar;
  process.noAsar = true;
  try {
    const source = path.join(runtime.root, "source");
    await fs.mkdir(source);
    await fs.writeFile(
      path.join(source, "package.json"),
      JSON.stringify({ version: "2.2.7" })
    );
    await fs.writeFile(path.join(source, "main.js"), "real app code");
    await fs.writeFile(path.join(source, "native.node"), "native bytes");
    await fs.writeFile(path.join(source, "readme.md"), "pruned metadata");
    const archive = path.join(runtime.root, "app.asar");
    const output = await createPackageWithOptions(source, archive, {
      unpack: "*.{node,md}",
    });
    await finished(output, { cleanup: true });
    await fs.unlink(path.join(`${archive}.unpacked`, "readme.md"));
    const updated = await repackTestSuccessorArchive(
      archive,
      "2.2.8",
      path.join(runtime.root, "next")
    );
    expect(
      JSON.parse(extractFile(updated, "package.json").toString()).version
    ).toBe("2.2.8");
    expect(extractFile(updated, "main.js").toString()).toBe("real app code");
    expect(extractFile(updated, "native.node").toString()).toBe("native bytes");
    expect(statFile(updated, "native.node").unpacked).toBe(true);
    expect(
      JSON.parse(extractFile(archive, "package.json").toString()).version
    ).toBe("2.2.7");
  } finally {
    runtime.cleanup();
    process.noAsar = previousNoAsar;
  }
});
it("serves only the declared repository, target and package through the isolated proxy", () => {
  const manifest = {
    ...identity,
    packages: { full: { filename: "ai-image-manager-2.2.7-full.nupkg" } },
  };
  expect(
    selectProductRequest(
      "api.github.com",
      "/repos/Uyoung666/ai-image-manager/releases?per_page=100",
      manifest
    ).json[0].tag_name
  ).toBe(identity.tag);
  expect(
    selectProductRequest(
      "github.com",
      "/Uyoung666/ai-image-manager/releases/download/v2.2.7/update-manifest.json",
      manifest
    ).json
  ).toBe(manifest);
  expect(
    selectProductRequest(
      "github.com",
      "/Uyoung666/ai-image-manager/releases/download/v2.2.7/ai-image-manager-2.2.7-full.nupkg",
      manifest
    ).info
  ).toBe(manifest.packages.full);
  expect(selectProductRequest("other.example", "/", manifest)).toBeNull();
  expect(
    selectProductRequest(
      "github.com",
      "/other/repository/releases/download/v2.2.7/update-manifest.json",
      manifest
    )
  ).toBeNull();
  expect(
    selectProductRequest(
      "github.com",
      "/Uyoung666/ai-image-manager/releases/download/v2.2.6/update-manifest.json",
      manifest
    )
  ).toBeNull();
});
