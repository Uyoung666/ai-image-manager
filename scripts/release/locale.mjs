import fsp from "node:fs/promises";
import path from "node:path";
import { sha256File } from "./checksums.mjs";

export const localeFilename = (version) =>
  `com.aiimagemanager.japanese-locale-${version}.aim-plugin`;
export const localeReportFilename = (version) =>
  `japanese-locale-${version}-compatibility.json`;

export async function verifyLocaleRelease(directory, identity) {
  if (!identity.localeRequired) {
    return null;
  }
  const plugin = localeFilename(identity.version);
  const reportName = localeReportFilename(identity.version);
  const report = JSON.parse(
    await fsp.readFile(path.join(directory, reportName), "utf8")
  );
  if (
    report.schemaVersion !== 1 ||
    report.status !== "passed" ||
    report.signature !== "verified" ||
    report.pluginId !== "com.aiimagemanager.japanese-locale" ||
    report.appVersion !== identity.version ||
    report.pluginVersion !== identity.version ||
    report.minimumAppVersion !== identity.version ||
    report.sourceCommit !== identity.commit ||
    report.packageSha256 !== (await sha256File(path.join(directory, plugin))) ||
    !report.signerKeyId ||
    !report.sourceCatalogSha256 ||
    !report.reviewSha256 ||
    !(report.total > 0)
  ) {
    throw new Error(
      "Japanese locale release report is incomplete or mismatched"
    );
  }
  return { plugin, reportName, report };
}

export function validateLocaleSmoke(smoke, manifest) {
  if (!manifest.localeRequired) {
    return;
  }
  const plugin = manifest.files.find(
    (file) => file.relativePath === `files/${localeFilename(manifest.version)}`
  );
  const executable = manifest.files.find((file) =>
    file.relativePath.endsWith(`-${manifest.version}.zip`)
  );
  const baseline = manifest.files.find(
    (file) => file.relativePath === "evidence/locale-baseline.aim-plugin"
  );
  if (
    !(plugin && executable && baseline) ||
    smoke.localeSmoke !== "passed" ||
    smoke.localePackageSha256 !== plugin.sha256 ||
    smoke.localeAppZipSha256 !== executable.sha256 ||
    smoke.localeBaselineSha256 !== baseline.sha256
  ) {
    throw new Error(
      "Japanese locale installation evidence is missing or refers to different release bytes"
    );
  }
}

export async function verifyLocaleBundle(root, manifest, expected) {
  if (expected.localeRequired && !manifest.localeRequired) {
    throw new Error("Recovery cannot bypass the Japanese locale release gate");
  }
  await verifyLocaleRelease(path.join(root, "files"), manifest);
  if (manifest.localeRequired) {
    const smoke = JSON.parse(
      await fsp.readFile(path.join(root, "evidence/locale-smoke.json"), "utf8")
    );
    validateLocaleSmoke(smoke, manifest);
  }
}
