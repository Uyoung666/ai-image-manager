#!/usr/bin/env node

/**
 * Release gate and Tencent COS promotion CLI.
 *
 * No Authenticode signing is attempted here. Every uploaded immutable object
 * carries SHA-256 metadata, SHA256SUMS.txt, and unsigned provenance instead.
 */
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCosStoreFromEnv } from "./release/cos.mjs";
import { invariant, ReleaseError } from "./release/errors.mjs";
import {
  prefixForKind,
  promoteRelease,
  uploadRelease,
  verifyRelease,
} from "./release/operations.mjs";
import {
  assertImmutableObject,
  validateReleaseGuard,
} from "./release/semver.mjs";

const VALUE_OPTIONS = new Set([
  "tag",
  "version",
  "latest-stable",
  "dir",
  "run-id",
  "prefix",
  "kind",
  "github-base-url",
  "existing-sha256",
  "existing-size",
  "key",
  "package",
  "lock",
]);
const BOOLEAN_OPTIONS = new Set([
  "allow-initial",
  "no-provenance",
  "compare-bytes",
  "require-releases",
  "json",
  "help",
]);

export const HELP_TEXT = `
AI Image Manager release COS tool

用法:
  node scripts/release-cos.mjs <command> [options]

命令:
  guard                    校验稳定 SemVer、tag、package-lock 和版本递增门禁
  upload-testing           上传到 updates/win32/x64/testing/runs/<run-id>
  upload-candidate         上传到 candidates/<version>
  upload-versioned         上传到 downloads/<version>
  upload-candidate/versioned  同时上传 candidate 与 immutable downloads
  promote                  先复制引用包，再切 stable/RELEASES 与真实 build-base
  verify                   校验 COS HEAD、SHA256SUMS 及可选 GitHub 字节

通用选项:
  --dir <path>             Electron/Squirrel 工件目录
  --version <x.y.z>        稳定版本（默认读取 package.json）
  --tag <vX.Y.Z>           Git tag（guard 必填；也接受 refs/tags/）
  --run-id <id>             testing 上传的运行标识
  --prefix <path>           verify 的显式前缀；promote 时为 candidate 前缀
  --kind <testing|candidate|versioned|stable>
  --latest-stable <x.y.z>  当前 stable 版本（或 LATEST_STABLE_VERSION）
  --allow-initial          guard 允许没有 latest stable（仅首发发布）
  --github-base-url <url>  verify 时按同名 asset 下载并比较字节
  --compare-bytes          verify 时读取 COS 对象并比较本地字节
  --no-provenance          不生成 provenance.json（不推荐）
  --json                   以 JSON 输出结果
  --help                   显示帮助

COS 配置从环境读取:
  COS_SECRET_ID, COS_SECRET_KEY, COS_BUCKET, COS_REGION
  COS_RELEASE_PREFIX（例如 ai-image-manager）
  可使用对应的 TENCENT_COS_* 别名及 COS_SESSION_TOKEN。
`;

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: CLI option parsing keeps all supported flags in one auditable boundary.
export function parseCliArgs(argv) {
  const args = [...argv];
  const command = args[0]?.startsWith("--") ? "help" : (args.shift() ?? "help");
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--") {
      options._ = [...args.slice(index + 1)];
      break;
    }
    if (!token.startsWith("--")) {
      throw new ReleaseError(`unexpected argument: ${token}`, {
        code: "CLI_ARGUMENT",
      });
    }
    const rawName = token.slice(2);
    const equalsIndex = rawName.indexOf("=");
    const name = equalsIndex === -1 ? rawName : rawName.slice(0, equalsIndex);
    const inlineValue =
      equalsIndex === -1 ? undefined : rawName.slice(equalsIndex + 1);
    if (!(VALUE_OPTIONS.has(name) || BOOLEAN_OPTIONS.has(name))) {
      throw new ReleaseError(`unknown option --${name}`, {
        code: "CLI_ARGUMENT",
      });
    }
    if (BOOLEAN_OPTIONS.has(name)) {
      options[name] =
        inlineValue === undefined ? true : inlineValue !== "false";
      continue;
    }
    const value = inlineValue ?? args[++index];
    invariant(
      value !== undefined && value !== "",
      `option --${name} requires a value`,
      "CLI_ARGUMENT"
    );
    options[name] = value;
  }
  return { command, options };
}

export function commandRequiresReleases(command, explicitlyRequested = false) {
  return (
    explicitlyRequested ||
    ["upload-candidate", "upload-candidate/versioned"].includes(command)
  );
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: command dispatch is intentionally centralized so CI has one stable entry point.
export async function runCli(
  argv = process.argv.slice(2),
  { cwd = process.cwd(), env = process.env } = {}
) {
  const { command, options } = parseCliArgs(argv);
  if (command === "help" || options.help) {
    console.log(HELP_TEXT.trim());
    return { command: "help" };
  }

  const packagePath = path.resolve(cwd, options.package ?? "package.json");
  const lockPath = path.resolve(cwd, options.lock ?? "package-lock.json");
  const packageJson = JSON.parse(await fsp.readFile(packagePath, "utf8"));
  const packageLock = JSON.parse(await fsp.readFile(lockPath, "utf8"));
  const version = options.version ?? packageJson.version;

  if (command === "guard") {
    const tag = options.tag ?? env.GITHUB_REF_NAME ?? env.GITHUB_REF;
    invariant(
      tag,
      "tag is required for guard; pass --tag or set GITHUB_REF_NAME",
      "TAG_MISSING"
    );
    const latestStableVersion =
      options["latest-stable"] ??
      env.LATEST_STABLE_VERSION ??
      env.COS_LATEST_STABLE_VERSION;
    const result = validateReleaseGuard({
      packageJson: { ...packageJson, version },
      packageLock,
      tag,
      latestStableVersion,
      requireLatestStable: !options["allow-initial"],
    });
    if (options.key && options["existing-sha256"] !== undefined) {
      const store = createCosStoreFromEnv(env);
      const existing = await store.head(options.key);
      if (existing) {
        const artifactPath = path.resolve(cwd, options.dir ?? "");
        invariant(
          options.dir,
          "--dir is required when checking an existing immutable object",
          "CLI_ARGUMENT"
        );
        const size =
          options["existing-size"] === undefined
            ? (await fsp.stat(artifactPath)).size
            : Number(options["existing-size"]);
        assertImmutableObject(existing, {
          sha256: options["existing-sha256"],
          size,
        });
      }
    }
    return emit(options, { command, ...result });
  }

  if (
    [
      "upload-testing",
      "upload-candidate",
      "upload-versioned",
      "upload-candidate/versioned",
    ].includes(command)
  ) {
    const artifactDirectory = path.resolve(
      cwd,
      options.dir ?? "out/make/squirrel.windows/x64"
    );
    await fsp.stat(artifactDirectory).catch(() => {
      throw new ReleaseError(
        `artifact directory does not exist: ${artifactDirectory}`,
        { code: "ARTIFACT_DIR_MISSING" }
      );
    });
    const store = createCosStoreFromEnv(env);
    const releasePrefix = env.COS_RELEASE_PREFIX ?? "";
    const generatedAt = env.SOURCE_DATE_EPOCH
      ? new Date(Number(env.SOURCE_DATE_EPOCH) * 1000).toISOString()
      : new Date().toISOString();
    const uploadOptions = {
      version,
      tag: options.tag ?? `v${version}`,
      generatedAt,
      includeProvenance: !options["no-provenance"],
      requireReleases: commandRequiresReleases(
        command,
        Boolean(options["require-releases"])
      ),
    };
    const results = [];
    if (command === "upload-testing") {
      invariant(
        options["run-id"],
        "--run-id is required for upload-testing",
        "RUN_ID_MISSING"
      );
      results.push(
        await uploadRelease(store, artifactDirectory, {
          ...uploadOptions,
          prefix: prefixForKind("testing", {
            runId: options["run-id"],
            releasePrefix,
          }),
          runId: options["run-id"],
        })
      );
    } else if (command === "upload-candidate") {
      results.push(
        await uploadRelease(store, artifactDirectory, {
          ...uploadOptions,
          prefix: prefixForKind("candidate", { version, releasePrefix }),
        })
      );
    } else if (command === "upload-versioned") {
      results.push(
        await uploadRelease(store, artifactDirectory, {
          ...uploadOptions,
          prefix: prefixForKind("versioned", { version, releasePrefix }),
        })
      );
    } else {
      results.push(
        await uploadRelease(store, artifactDirectory, {
          ...uploadOptions,
          prefix: prefixForKind("candidate", { version, releasePrefix }),
        })
      );
      results.push(
        await uploadRelease(store, artifactDirectory, {
          ...uploadOptions,
          prefix: prefixForKind("versioned", { version, releasePrefix }),
        })
      );
    }
    return emit(options, { command, version, results });
  }

  if (command === "promote") {
    const store = createCosStoreFromEnv(env);
    const result = await promoteRelease(store, version, {
      candidatePrefix: options.prefix,
      releasePrefix: env.COS_RELEASE_PREFIX ?? "",
    });
    return emit(options, { command, ...result });
  }

  if (command === "verify") {
    const artifactDirectory = path.resolve(
      cwd,
      options.dir ?? "out/make/squirrel.windows/x64"
    );
    const store = createCosStoreFromEnv(env);
    const result = await verifyRelease(store, artifactDirectory, {
      prefix:
        options.prefix ??
        prefixForKind(options.kind ?? "versioned", {
          version: options.version ?? version,
          runId: options["run-id"],
          releasePrefix: env.COS_RELEASE_PREFIX ?? "",
        }),
      version: options.version ?? version,
      runId: options["run-id"],
      githubBaseUrl: options["github-base-url"],
      compareBytes: Boolean(
        options["compare-bytes"] || options["github-base-url"]
      ),
    });
    return emit(options, { command, ...result });
  }

  throw new ReleaseError(`unknown command: ${command}; use --help`, {
    code: "CLI_COMMAND",
  });
}

function emit(options, result) {
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatHumanResult(result));
  }
  return result;
}

function formatHumanResult(result) {
  if (result.command === "guard") {
    return `guard passed: ${result.tag} (latest stable: ${result.latestStableVersion ?? "none"})`;
  }
  if (result.command === "promote") {
    return `promoted ${result.version}: stable pointers updated (${result.actions.length} operation(s))`;
  }
  if (result.results) {
    const uploads = result.results.reduce(
      (sum, item) => sum + item.uploaded.length,
      0
    );
    return `${result.command} passed: ${uploads} object(s) processed`;
  }
  if (result.command === "verify") {
    return `verify passed: ${result.checked.length} object(s)`;
  }
  return `${result.command} passed`;
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runCli().catch((error) => {
    const message =
      error instanceof ReleaseError
        ? error.message
        : (error?.stack ?? String(error));
    console.error(`release error: ${message}`);
    process.exitCode = 1;
  });
}

// biome-ignore lint/performance/noBarrelFile: the CLI is also the documented import boundary for release automation tests.
export * from "./release/checksums.mjs";
export * from "./release/cos.mjs";
export * from "./release/errors.mjs";
export * from "./release/operations.mjs";
export * from "./release/semver.mjs";
export * from "./release/squirrel.mjs";
