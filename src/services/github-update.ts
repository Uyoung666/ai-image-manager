export const GITHUB_UPDATE_REPOSITORY = "Uyoung666/ai-image-manager";

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA1_PATTERN = /^[a-f0-9]{40}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const PACKAGE_PATH_PATTERN = /[\\/\0]/;
const TRAILING_SLASH_RE = /\/+$/;

export interface UpdatePackage {
  filename: string;
  fromVersion?: string;
  sha1: string;
  sha256: string;
  size: number;
  toVersion?: string;
  url: string;
}

export interface GitHubUpdateManifest {
  assetsBaseUrl: string;
  packages: {
    delta?: UpdatePackage;
    full: UpdatePackage;
  };
  platform: "win32-x64";
  releaseUrl: string;
  repository: string;
  schemaVersion: 1;
  tag: string;
  version: string;
}

export interface UpdatePlan {
  currentVersion: string;
  fallback: UpdatePackage;
  manifest: GitHubUpdateManifest;
  method: "delta" | "full";
  package: UpdatePackage;
  targetVersion: string;
}

export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) {
      return a[index] > b[index] ? 1 : -1;
    }
  }
  return 0;
}

export function releaseApiURL(repository = GITHUB_UPDATE_REPOSITORY): string {
  return `https://api.github.com/repos/${repository}/releases?per_page=100`;
}

export function releaseAssetURL(
  repository: string,
  tag: string,
  filename: string
): string {
  return `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(filename)}`;
}

export function selectLatestRelease<
  T extends {
    draft?: boolean;
    prerelease?: boolean;
    tag_name?: string;
  },
>(releases: T[], currentVersion: string): T | null {
  return (
    releases
      .filter(
        (release) =>
          !(release.draft || release.prerelease) &&
          typeof release.tag_name === "string" &&
          release.tag_name.startsWith("v") &&
          isStableVersion(release.tag_name.slice(1)) &&
          compareVersions(release.tag_name.slice(1), currentVersion) > 0
      )
      .sort((left, right) =>
        compareVersions(
          right.tag_name?.slice(1) ?? "0.0.0",
          left.tag_name?.slice(1) ?? "0.0.0"
        )
      )[0] ?? null
  );
}

export function parseUpdateManifest(
  value: unknown,
  expectedRepository = GITHUB_UPDATE_REPOSITORY
): GitHubUpdateManifest {
  if (!value || typeof value !== "object") {
    throw new Error("Update manifest is not an object");
  }
  const source = value as Partial<GitHubUpdateManifest>;
  if (
    source.schemaVersion !== 1 ||
    source.repository !== expectedRepository ||
    source.platform !== "win32-x64" ||
    typeof source.version !== "string" ||
    !isStableVersion(source.version) ||
    source.tag !== `v${source.version}` ||
    !source.packages?.full
  ) {
    throw new Error("Update manifest identity is invalid");
  }
  validateURL(
    source.assetsBaseUrl,
    expectedRepository,
    `/releases/download/${source.tag}`
  );
  validateURL(
    source.releaseUrl,
    expectedRepository,
    `/releases/tag/${source.tag}`
  );
  validatePackage(
    source.packages.full,
    source.version,
    expectedRepository,
    "full"
  );
  if (source.packages.delta) {
    validatePackage(
      source.packages.delta,
      source.version,
      expectedRepository,
      "delta"
    );
    if (
      !(
        source.packages.delta.fromVersion &&
        isStableVersion(source.packages.delta.fromVersion) &&
        compareVersions(source.packages.delta.fromVersion, source.version) <
          0 &&
        source.packages.delta.toVersion === source.version
      )
    ) {
      throw new Error("Delta package baseline is invalid");
    }
  }
  return source as GitHubUpdateManifest;
}

export function chooseUpdatePlan(
  currentVersion: string,
  manifest: GitHubUpdateManifest
): UpdatePlan | null {
  if (compareVersions(manifest.version, currentVersion) <= 0) {
    return null;
  }
  const delta = manifest.packages.delta;
  if (
    delta &&
    delta.fromVersion === currentVersion &&
    delta.size < manifest.packages.full.size
  ) {
    return {
      currentVersion,
      fallback: manifest.packages.full,
      manifest,
      method: "delta",
      package: delta,
      targetVersion: manifest.version,
    };
  }
  return {
    currentVersion,
    fallback: manifest.packages.full,
    manifest,
    method: "full",
    package: manifest.packages.full,
    targetVersion: manifest.version,
  };
}

function validatePackage(
  value: UpdatePackage,
  version: string,
  repository: string,
  kind: "delta" | "full"
): void {
  if (
    !value ||
    typeof value.filename !== "string" ||
    PACKAGE_PATH_PATTERN.test(value.filename) ||
    !value.filename.endsWith(".nupkg") ||
    typeof value.size !== "number" ||
    !Number.isSafeInteger(value.size) ||
    value.size <= 0 ||
    !SHA1_PATTERN.test(value.sha1) ||
    !SHA256_PATTERN.test(value.sha256)
  ) {
    throw new Error("Update package metadata is invalid");
  }
  const suffix = value.filename.toLowerCase();
  if (!suffix.endsWith(`-${version}-${kind}.nupkg`)) {
    throw new Error("Update package version does not match the manifest");
  }
  validateURL(
    value.url,
    repository,
    `/releases/download/v${version}/${encodeURIComponent(value.filename)}`
  );
}

function validateURL(
  value: unknown,
  repository: string,
  expectedPath: string
): void {
  if (typeof value !== "string") {
    throw new Error("Update manifest URL is missing");
  }
  let url: URL;
  let pathname: string;
  try {
    url = new URL(value);
    pathname = decodeURIComponent(url.pathname).replace(TRAILING_SLASH_RE, "");
  } catch {
    throw new Error("Update manifest URL is invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    pathname !== `/${repository}${expectedPath}`
  ) {
    throw new Error("Update manifest URL is not a fixed GitHub release URL");
  }
}

function isStableVersion(value: string): boolean {
  return VERSION_PATTERN.test(value);
}

function parseVersion(value: string): [bigint, bigint, bigint] {
  const match = VERSION_PATTERN.exec(value);
  if (!match) {
    throw new Error(`Invalid stable version: ${value}`);
  }
  return [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])];
}
