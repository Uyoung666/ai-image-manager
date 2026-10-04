import { execFileSync } from "node:child_process";
import { createPublicKey, verify } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkLocaleContract,
  readCatalogs,
  textHash,
} from "./locale-contract.mjs";
import {
  packPlugin,
  validatePluginDirectory,
  validatePluginPackage,
} from "./plugin-cli.mjs";

export const LOCALE_PLUGIN_ID = "com.aiimagemanager.japanese-locale";
export const localeFilename = (version) =>
  `${LOCALE_PLUGIN_ID}-${version}.aim-plugin`;
export const localeReportFilename = (version) =>
  `japanese-locale-${version}-compatibility.json`;
const readJson = async (file) => JSON.parse(await fs.readFile(file, "utf8"));

export function verifyLocalePackageSignature(result, keys) {
  const signature = JSON.parse(
    result.files.get("signature.json")?.toString("utf8") ?? "null"
  );
  const pem = signature && keys[signature.keyId];
  if (signature?.algorithm !== "ed25519" || !pem) {
    throw new Error("Locale package has no trusted official signature");
  }
  const entries = [...result.files]
    .filter(([name]) => name !== "signature.json")
    .sort(([a], [b]) => {
      if (a < b) {
        return -1;
      }
      if (a > b) {
        return 1;
      }
      return 0;
    })
    .map(([name, bytes]) => ({
      path: name,
      size: bytes.length,
      sha256: textHash(bytes),
    }));
  const key = createPublicKey(pem);
  if (
    key.asymmetricKeyType !== "ed25519" ||
    !verify(
      null,
      Buffer.from(JSON.stringify(entries)),
      key,
      Buffer.from(signature.signature, "base64")
    )
  ) {
    throw new Error("Locale package signature verification failed");
  }
  return signature.keyId;
}

export async function checkJapaneseLocale(root, baselineRef) {
  const directory = path.join(root, "external-plugins/japanese-locale");
  const { manifest } = await validatePluginDirectory(directory);
  const pkg = await readJson(path.join(root, "package.json"));
  if (
    manifest.id !== LOCALE_PLUGIN_ID ||
    manifest.version !== pkg.version ||
    manifest.engine.minAppVersion !== pkg.version
  ) {
    throw new Error(
      "Japanese plugin ID, version and minimum app version must match the application"
    );
  }
  const maintenance = await readJson(
    path.join(root, "external-plugins/japanese-locale-maintenance.json")
  );
  const ref = baselineRef ?? maintenance.baselineRef;
  const current = readCatalogs(root);
  const previous = readCatalogs(root, ref);
  const checks = checkLocaleContract({
    ...current,
    previousSource: previous.source,
    previousTranslation: previous.translation,
    reviews: maintenance.reviews,
  });
  if (checks.errors.length) {
    throw new Error(
      `Japanese locale compatibility failed:\n${checks.errors.join("\n")}`
    );
  }
  const previousManifest = JSON.parse(
    execFileSync(
      "git",
      ["show", `${ref}:external-plugins/japanese-locale/plugin.json`],
      {
        cwd: root,
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      }
    )
  );
  if (
    previousManifest.version === manifest.version &&
    (JSON.stringify(previous.translation) !==
      JSON.stringify(current.translation) ||
      JSON.stringify(previousManifest) !== JSON.stringify(manifest))
  ) {
    throw new Error(
      "Japanese translations changed without a new plugin version"
    );
  }
  return {
    schemaVersion: 1,
    pluginId: LOCALE_PLUGIN_ID,
    appVersion: pkg.version,
    pluginVersion: manifest.version,
    minimumAppVersion: manifest.engine.minAppVersion,
    baselineRef: ref,
    sourceCatalogSha256: checks.sourceCatalogSha256,
    reviewSha256: textHash(JSON.stringify(maintenance.reviews)),
    total: checks.total,
    changedEnglish: checks.changed,
    status: "passed",
  };
}

export async function buildJapaneseLocale(
  root,
  {
    baselineRef,
    signingKeyPath,
    keyId = "uyoung-locale-release-1",
    out = path.join(root, "dist/plugins"),
  } = {}
) {
  const report = await checkJapaneseLocale(root, baselineRef);
  const keys = await readJson(
    path.join(root, "src/plugins/official-locale-public-keys.json")
  );
  if (!(signingKeyPath && keys[keyId])) {
    throw new Error(
      "Official locale signing key path and trusted key ID are required"
    );
  }
  const packed = await packPlugin(
    path.join(root, "external-plugins/japanese-locale"),
    { out, signingKeyPath, keyId }
  );
  const signerKeyId = verifyLocalePackageSignature(
    await validatePluginPackage(packed.outputPath),
    keys
  );
  const previousManifest = JSON.parse(
    execFileSync(
      "git",
      [
        "show",
        `${report.baselineRef}:external-plugins/japanese-locale/plugin.json`,
      ],
      { cwd: root, encoding: "utf8", windowsHide: true }
    )
  );
  const previous = readCatalogs(root, report.baselineRef);
  const fixture = path.join(out, ".upgrade-source");
  await fs.mkdir(path.join(fixture, "locales/ja-JP"), { recursive: true });
  await fs.writeFile(
    path.join(fixture, "plugin.json"),
    JSON.stringify(previousManifest)
  );
  for (const kind of ["renderer", "main"]) {
    await fs.writeFile(
      path.join(fixture, `locales/ja-JP/${kind}.json`),
      JSON.stringify(previous.translation[kind])
    );
  }
  await packPlugin(fixture, {
    out: path.join(out, "locale-baseline.aim-plugin"),
    signingKeyPath,
    keyId,
  });
  const packageSha256 = textHash(await fs.readFile(packed.outputPath));
  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  }).trim();
  const result = {
    ...report,
    sourceCommit,
    signerKeyId,
    packageSha256,
    baselinePluginVersion: previousManifest.version,
    signature: "verified",
  };
  await fs.writeFile(
    path.join(out, localeReportFilename(report.appVersion)),
    `${JSON.stringify(result, null, 2)}\n`
  );
  return { ...result, outputPath: packed.outputPath };
}

async function main() {
  const root = path.resolve(import.meta.dirname, "..");
  const [operation = "check", ...args] = process.argv.slice(2);
  const option = (name) => {
    const index = args.indexOf(name);
    return index < 0 ? undefined : args[index + 1];
  };
  const baselineRef = option("--baseline") ?? process.env.LOCALE_BASELINE_REF;
  if (operation === "sync-version") {
    const pkg = await readJson(path.join(root, "package.json"));
    const file = path.join(
      root,
      "external-plugins/japanese-locale/plugin.json"
    );
    const manifest = await readJson(file);
    manifest.version = pkg.version;
    manifest.engine.minAppVersion = pkg.version;
    await fs.writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`Japanese locale version synchronized to ${pkg.version}`);
    return;
  }
  let result;
  if (operation === "check") {
    result = await checkJapaneseLocale(root, baselineRef);
  } else if (operation === "build") {
    result = await buildJapaneseLocale(root, {
      baselineRef,
      signingKeyPath:
        option("--sign-key") ?? process.env.LOCALE_SIGNING_KEY_PATH,
      keyId: option("--key-id") ?? process.env.LOCALE_SIGNING_KEY_ID,
      out: option("--out"),
    });
  } else {
    throw new Error(`Unknown locale operation: ${operation}`);
  }
  console.log(JSON.stringify(result, null, 2));
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
