import { describe, expect, it } from "vitest";
import {
  chooseUpdatePlan,
  GITHUB_UPDATE_REPOSITORY,
  parseUpdateManifest,
  releaseApiURL,
  releaseAssetURL,
  selectLatestRelease,
} from "@/services/github-update";

const FIXED_URL_RE = /fixed GitHub release URL/;
const BASELINE_RE = /baseline/;

function packageInfo(
  version: string,
  kind: "full" | "delta",
  size: number,
  fromVersion?: string
) {
  const filename = `ai-image-manager-${version}-${kind}.nupkg`;
  return {
    filename,
    fromVersion,
    sha1: "a".repeat(40),
    sha256: "b".repeat(64),
    size,
    toVersion: kind === "delta" ? version : undefined,
    url: releaseAssetURL(GITHUB_UPDATE_REPOSITORY, `v${version}`, filename),
  };
}

function manifest(version = "2.2.1") {
  const tag = `v${version}`;
  return {
    schemaVersion: 1 as const,
    repository: GITHUB_UPDATE_REPOSITORY,
    platform: "win32-x64" as const,
    version,
    tag,
    releaseUrl: `https://github.com/${GITHUB_UPDATE_REPOSITORY}/releases/tag/${tag}`,
    assetsBaseUrl: `https://github.com/${GITHUB_UPDATE_REPOSITORY}/releases/download/${tag}`,
    packages: {
      full: packageInfo(version, "full", 100),
      delta: packageInfo(version, "delta", 20, "2.2.0"),
    },
  };
}

describe("GitHub update metadata", () => {
  it("selects the highest formal release and ignores drafts and prereleases", () => {
    expect(
      selectLatestRelease(
        [
          { tag_name: "v2.2.1", draft: false, prerelease: false },
          { tag_name: "v2.4.0", draft: false, prerelease: true },
          { tag_name: "v2.3.0", draft: true, prerelease: false },
          { tag_name: "v2.2.2", draft: false, prerelease: false },
        ],
        "2.2.0"
      )?.tag_name
    ).toBe("v2.2.2");
  });

  it("chooses an adjacent delta and keeps a full fallback for its target", () => {
    const parsed = parseUpdateManifest(manifest());
    const plan = chooseUpdatePlan("2.2.0", parsed);
    expect(plan?.method).toBe("delta");
    expect(plan?.package.filename).toContain("-delta.nupkg");
    expect(plan?.fallback.filename).toContain("-full.nupkg");
  });

  it("uses the full package for a cross-version update or an oversized delta", () => {
    const parsed = parseUpdateManifest(manifest());
    expect(chooseUpdatePlan("2.1.0", parsed)?.method).toBe("full");
    const oversized = parseUpdateManifest({
      ...manifest(),
      packages: {
        ...manifest().packages,
        delta: packageInfo("2.2.1", "delta", 100, "2.2.0"),
      },
    });
    expect(chooseUpdatePlan("2.2.0", oversized)?.method).toBe("full");
  });

  it("rejects mutable or mismatched download URLs and invalid delta baselines", () => {
    expect(() =>
      parseUpdateManifest({
        ...manifest(),
        packages: {
          ...manifest().packages,
          full: {
            ...manifest().packages.full,
            url: "https://objects.githubusercontent.com/other.nupkg",
          },
        },
      })
    ).toThrow(FIXED_URL_RE);
    expect(() =>
      parseUpdateManifest({
        ...manifest(),
        packages: {
          ...manifest().packages,
          delta: packageInfo("2.2.1", "delta", 20, "2.2"),
        },
      })
    ).toThrow(BASELINE_RE);
    expect(() =>
      parseUpdateManifest({
        ...manifest(),
        packages: {
          ...manifest().packages,
          delta: {
            ...manifest().packages.delta,
            toVersion: "2.2.0",
          },
        },
      })
    ).toThrow(BASELINE_RE);
  });

  it("builds immutable API and asset endpoints", () => {
    expect(releaseApiURL()).toBe(
      `https://api.github.com/repos/${GITHUB_UPDATE_REPOSITORY}/releases?per_page=100`
    );
    expect(
      releaseAssetURL(
        GITHUB_UPDATE_REPOSITORY,
        "v2.2.1",
        "update-manifest.json"
      )
    ).toBe(
      `https://github.com/${GITHUB_UPDATE_REPOSITORY}/releases/download/v2.2.1/update-manifest.json`
    );
  });
});
