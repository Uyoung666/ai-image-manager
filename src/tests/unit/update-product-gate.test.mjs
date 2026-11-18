// @vitest-environment node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { finished } from "node:stream/promises";
import {
  createPackageWithOptions,
  extractFile,
  statFile,
} from "@electron/asar";
import { expect, it, vi } from "vitest";
import { validateSmoke } from "../../../scripts/release/bundle.mjs";
import {
  cleanupProductSession,
  expectRestart,
  installedTargetPath,
  isolateHistoricalMsiControl,
  readProductStartupCrash,
  repackTestSuccessorArchive,
  verifyMetadataFallback,
  verifyProductDownload,
} from "../../../scripts/release/update-product-gate.mjs";
import {
  certificatePowerShellScript,
  createProductUpdateProxy,
  isDisposableWindowsRunner,
  PRODUCT_LATEST_MANIFEST,
  PRODUCT_RELEASE_LIST,
  selectProductRequest,
} from "../../../scripts/release/update-product-proxy.mjs";
import { TestRuntime } from "../helpers/test-runtime";

it("verifies the hosted candidate's official manifest route after an API limit", () => {
  const manifest = { tag: "v2.2.12", packages: {} };
  const list = {
    host: "api.github.com",
    url: `${PRODUCT_RELEASE_LIST}?per_page=100`,
  };
  const latest = { host: "github.com", url: PRODUCT_LATEST_MANIFEST };
  const limited = selectProductRequest(list.host, list.url, manifest, true);
  const redirect = selectProductRequest(
    latest.host,
    latest.url,
    manifest,
    true
  );
  expect(limited).toMatchObject({
    status: 429,
    headers: { "retry-after": "60" },
  });
  expect(redirect).toEqual({
    status: 302,
    headers: {
      location:
        "https://github.com/Uyoung666/ai-image-manager/releases/download/v2.2.12/update-manifest.json",
    },
  });
  const trace = [
    { ...list, status: limited.status },
    { ...latest, status: redirect.status },
  ];
  expect(() => verifyMetadataFallback(trace)).not.toThrow();
  expect(() => verifyMetadataFallback(trace.slice(0, 1))).toThrow(
    "rate limiting"
  );
  expect(() => verifyMetadataFallback(trace.toReversed())).toThrow(
    "rate limiting"
  );
});

const identity = {
  version: "2.2.7",
  tag: "v2.2.7",
  commit: "a".repeat(40),
  productUpdateGateRequired: true,
};
const hash = "b".repeat(64);

it("reports only new startup crashes and handles rotated or absent logs", async () => {
  const runtime = new TestRuntime("product-startup-crash");
  const log = path.join(runtime.root, "crash.log");
  const warning = vi
    .spyOn(console, "error")
    .mockImplementation(() => undefined);
  try {
    await fs.writeFile(log, "old incident\n");
    expect(await readProductStartupCrash(log, "old incident\n")).toBe("");
    expect(warning).not.toHaveBeenCalled();
    await fs.appendFile(log, "EPERM opening startup.log\n");
    expect(await readProductStartupCrash(log, "old incident\n")).toBe(
      "EPERM opening startup.log\n"
    );
    await fs.writeFile(log, "rotated startup failure\n");
    expect(await readProductStartupCrash(log, "old incident\n")).toBe(
      "rotated startup failure\n"
    );
    expect(
      await readProductStartupCrash(path.join(runtime.root, "absent.log"), "")
    ).toBe("");
  } finally {
    warning.mockRestore();
    runtime.cleanup();
  }
});

it("isolates the persisted old MSI failure from the following candidate upgrade", async () => {
  const runtime = new TestRuntime("msi-control-isolation");
  try {
    const executable = path.join(runtime.root, "app.exe");
    const profile = path.join(runtime.root, "profile");
    const directory = path.join(runtime.root, "control");
    const healthy = JSON.stringify({ state: { phase: "idle" } });
    await fs.mkdir(profile);
    await fs.writeFile(executable, "released 2.2.8 executable");
    await fs.writeFile(path.join(profile, "update-state.json"), healthy);
    await fs.writeFile(path.join(profile, "album.db"), "retained album");
    const result = await isolateHistoricalMsiControl(
      executable,
      profile,
      directory,
      async (isolatedProfile) => {
        expect(isolatedProfile).not.toBe(profile);
        expect(
          await fs.readFile(path.join(isolatedProfile, "album.db"), "utf8")
        ).toBe("retained album");
        await fs.writeFile(
          path.join(isolatedProfile, "update-state.json"),
          JSON.stringify({
            state: {
              phase: "error",
              operation: "install",
              version: "2.2.9",
              canResume: true,
            },
          })
        );
        return { status: "reproduced", message: "UPDATE_INSTALL_INTERRUPTED" };
      }
    );
    expect(result).toEqual({
      status: "reproduced",
      message: "UPDATE_INSTALL_INTERRUPTED",
      profileIsolated: true,
      sourceExecutableSha256: createHash("sha256")
        .update("released 2.2.8 executable")
        .digest("hex"),
    });
    expect(
      await fs.readFile(path.join(profile, "update-state.json"), "utf8")
    ).toBe(healthy);
    expect(await fs.readFile(path.join(profile, "album.db"), "utf8")).toBe(
      "retained album"
    );
  } finally {
    runtime.cleanup();
  }
});

it.each([
  "executable",
  "state",
])("rejects a negative control that changes the original %s", async (changed) => {
  const runtime = new TestRuntime("msi-control-source");
  try {
    const executable = path.join(runtime.root, "app.exe");
    const profile = path.join(runtime.root, "profile");
    const state = path.join(profile, "update-state.json");
    await fs.mkdir(profile);
    await fs.writeFile(executable, "original executable");
    await fs.writeFile(state, "original update state");
    await expect(
      isolateHistoricalMsiControl(
        executable,
        profile,
        path.join(runtime.root, "control"),
        async () => {
          await fs.writeFile(
            changed === "state" ? state : executable,
            "changed"
          );
          return { status: "reproduced" };
        }
      )
    ).rejects.toThrow("changed the candidate source");
  } finally {
    runtime.cleanup();
  }
});

it("preserves an unexpected negative-control failure", async () => {
  const runtime = new TestRuntime("msi-control-error");
  try {
    const executable = path.join(runtime.root, "app.exe");
    const profile = path.join(runtime.root, "profile");
    await fs.mkdir(profile);
    await fs.writeFile(executable, "original executable");
    await fs.writeFile(
      path.join(profile, "update-state.json"),
      "original state"
    );
    await expect(
      isolateHistoricalMsiControl(
        executable,
        profile,
        path.join(runtime.root, "control"),
        () => {
          throw new Error("unexpected installer failure");
        }
      )
    ).rejects.toThrow("unexpected installer failure");
  } finally {
    runtime.cleanup();
  }
});

it("reports the real installation error promptly instead of waiting for a restart", async () => {
  vi.useFakeTimers();
  const browser = new EventEmitter();
  try {
    const restart = expectRestart(
      browser,
      () => undefined,
      () => ({
        phase: "error",
        message: "UPDATE_INSTALL_INTERRUPTED",
        installerExitCode: 4_294_967_295,
      })
    );
    const assertion = expect(restart).rejects.toThrow(
      "UPDATE_INSTALL_INTERRUPTED"
    );
    await vi.advanceTimersByTimeAsync(250);
    await assertion;
    expect(browser.listenerCount("disconnected")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it("tolerates an atomic state replacement and cleans observation after real restart", async () => {
  vi.useFakeTimers();
  const browser = new EventEmitter();
  try {
    const restart = expectRestart(
      browser,
      () => undefined,
      () => {
        throw new Error("temporary read failure");
      }
    );
    await vi.advanceTimersByTimeAsync(250);
    browser.emit("disconnected");
    await restart;
    expect(browser.listenerCount("disconnected")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it.each([
  "full",
  "delta",
])("verifies real %s downloads against both the published manifest and installed bytes", async (method) => {
  const runtime = new TestRuntime("product-package-proof");
  try {
    const bytes = Buffer.from("verified package");
    const filename = `ai-image-manager-2.2.8-${method}.nupkg`;
    const info = {
      filename,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.length,
      url: `https://github.com/Uyoung666/ai-image-manager/releases/download/v2.2.8/${filename}`,
    };
    const manifest = {
      version: "2.2.8",
      packages: {
        full: {
          ...info,
          url: info.url.replace("-delta.nupkg", "-full.nupkg"),
        },
        [method]: info,
      },
    };
    const state = { version: "2.2.8", updateMethod: method };
    const trace = [{ host: "github.com", url: new URL(info.url).pathname }];
    await fs.mkdir(path.join(runtime.root, "packages"));
    const file = path.join(runtime.root, "packages", filename);
    await fs.writeFile(file, bytes);
    await expect(
      verifyProductDownload(state, manifest, trace, runtime.root)
    ).resolves.toEqual({
      updateMethod: method,
      downloadedPackageSha256: info.sha256,
    });
    if (method === "delta") {
      const fallback = {
        host: "github.com",
        url: new URL(manifest.packages.full.url).pathname,
      };
      await expect(
        verifyProductDownload(
          state,
          manifest,
          [...trace, fallback],
          runtime.root
        )
      ).rejects.toThrow("full fallback");
    }
    await expect(
      verifyProductDownload(state, manifest, [], runtime.root)
    ).rejects.toThrow("did not download");
    await expect(
      verifyProductDownload(
        { ...state, updateMethod: method === "full" ? "delta" : "full" },
        manifest,
        trace,
        runtime.root
      )
    ).rejects.toThrow("did not download");
    await fs.writeFile(file, Buffer.alloc(bytes.length));
    await expect(
      verifyProductDownload(state, manifest, trace, runtime.root)
    ).rejects.toThrow("differs");
  } finally {
    runtime.cleanup();
  }
});

it("cleans every resource after quit fails and preserves the original upgrade error", async () => {
  const primary = new Error("real UI failure");
  const calls = [];
  const warning = vi
    .spyOn(console, "error")
    .mockImplementation(() => undefined);
  try {
    const operation = async () => {
      try {
        throw primary;
      } finally {
        await cleanupProductSession(
          [
            [
              "normal quit",
              () => {
                calls.push("quit");
                throw new Error("quit timed out");
              },
            ],
            [
              "disconnect CDP",
              () => {
                calls.push("disconnect");
                throw new Error("disconnect failed");
              },
            ],
            ["stop owned child", () => calls.push("stop")],
            ["close proxy", () => calls.push("proxy")],
          ],
          primary
        );
      }
    };
    await expect(operation()).rejects.toBe(primary);
    expect(calls).toEqual(["quit", "disconnect", "stop", "proxy"]);
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining("quit timed out")
    );
  } finally {
    warning.mockRestore();
  }
});

it("bounds a stuck cleanup and fails the gate after releasing the remaining resources", async () => {
  let proxyClosed = false;
  await expect(
    cleanupProductSession([
      ["disconnect CDP", () => new Promise(() => undefined), 10],
      [
        "close proxy",
        () => {
          proxyClosed = true;
        },
      ],
    ])
  ).rejects.toThrow("disconnect CDP: cleanup deadline exceeded");
  expect(proxyClosed).toBe(true);
});

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
    updateMethod: "full",
    downloadedPackageSha256: hash,
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
      value.productUpdateEvidence[0].first.downloadedPackageSha256 = undefined;
    },
    (value) => {
      value.productUpdateEvidence[0].first.downloadedPackageSha256 = "c".repeat(
        64
      );
    },
    (value) => {
      value.productUpdateEvidence[0].first.updateMethod = "skipped";
    },
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
