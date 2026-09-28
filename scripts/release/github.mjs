import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { assertIdentity, downloadRecords } from "./bundle.mjs";
import { readFileRecord } from "./checksums.mjs";
import { compareVersions, isStableVersion } from "./semver.mjs";

const RUN_ID_PATTERN = /^[1-9]\d*$/;
const UPLOAD_TEMPLATE_PATTERN = /\{.*$/;
const TAG_PREFIX_PATTERN = /^v/;
const BOM_PATTERN = /^\uFEFF/;
const LINE_PATTERN = /\r?\n/;
const NOTES_METADATA_PATTERN =
  /^(?:#|\*{0,2}Full Changelog\*{0,2}\s*:|\[Full Changelog\]|https?:\/\/|Release v\d+\.\d+\.\d+$)/i;

export function validateReleaseNotes(text) {
  const body = String(text ?? "")
    .replace(BOM_PATTERN, "")
    .trim();
  if (
    !body
      .split(LINE_PATTERN)
      .some((line) => line.trim() && !NOTES_METADATA_PATTERN.test(line.trim()))
  ) {
    throw new Error(
      "Release notes must describe changes, not just a title or changelog link"
    );
  }
  return body;
}

export async function loadReleaseNotes(manifest, runCommand = command) {
  assertIdentity(manifest);
  if (manifest.releaseNotes !== undefined) {
    return validateReleaseNotes(manifest.releaseNotes);
  }
  const file = `RELEASE_NOTES_${manifest.tag}.md`;
  let text;
  try {
    text = await runCommand("git", ["show", `${manifest.commit}:${file}`]);
  } catch (cause) {
    throw new Error(
      `Release requires ${file} in application commit ${manifest.commit}`,
      { cause }
    );
  }
  return validateReleaseNotes(text);
}

export function command(
  program,
  args,
  { input, timeoutMs = 120_000, inherit = false } = {}
) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      windowsHide: true,
      stdio: [input ? "pipe" : "ignore", inherit ? "inherit" : "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (inherit) {
        process.stderr.write(chunk);
      }
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(
          new Error(
            `${program} ${args[0]} failed (${code}): ${stderr.slice(-2000)}`
          )
        );
      }
    });
    if (input) {
      child.stdin.end(input);
    }
  });
}

export async function api(route, { method = "GET", body } = {}) {
  const args = ["api", "--method", method, route];
  if (body) {
    args.push("--input", "-");
  }
  const text = await command("gh", args, {
    input: body ? JSON.stringify(body) : undefined,
  });
  return text ? JSON.parse(text) : null;
}

export async function findRelease(repo, tag) {
  // List includes drafts for authenticated maintainers; only an actual absent
  // tag is considered missing. Authentication/network errors must propagate.
  const pages = await command("gh", [
    "api",
    "--paginate",
    "--slurp",
    `repos/${repo}/releases?per_page=100`,
  ]);
  return (
    JSON.parse(pages)
      .flat()
      .find((release) => release.tag_name === tag) ?? null
  );
}

export function validateSourceRun(run, jobs) {
  if (
    run.path !== ".github/workflows/publish.yaml" ||
    run.status !== "completed" ||
    !["push", "workflow_dispatch"].includes(run.event)
  ) {
    throw new Error("Recovery source must be a completed release workflow run");
  }
  const steps = jobs.flatMap((job) => job.steps ?? []);
  const modern = steps.some(
    (step) => step.name === "Save immutable release bundle"
  );
  const required = modern
    ? [
        "Save immutable release bundle",
        "Attest release bundle",
        "Save installer smoke evidence",
      ]
    : [
        "Gate - static check",
        "Gate - unit tests",
        "Upload candidate to COS testing",
        "Run Squirrel Setup.exe upgrade smoke",
        "Run MSI install or auto-update smoke",
        "Write candidate smoke evidence",
        "Upload Squirrel candidate to COS candidate prefix",
        "Upload immutable versioned download payload to COS",
        "Upload candidate build for promotion",
        "Generate SHA256 release manifest",
        "Attest candidate artifacts",
        "Attest flat download and checksum artifacts",
        "Upload candidate evidence",
      ];
  for (const name of required) {
    if (
      steps.filter(
        (step) => step.name === name && step.conclusion === "success"
      ).length !== 1
    ) {
      throw new Error(`Recovery source did not pass: ${name}`);
    }
  }
  if (!modern) {
    const failed = steps.filter((step) => step.conclusion === "failure");
    if (
      run.conclusion !== "failure" ||
      failed.length !== 1 ||
      ![
        "Report GitHub prerelease handoff",
        "Publish GitHub Draft from Forge dry-run",
        "Create GitHub Draft from the staged candidate payload",
      ].includes(failed[0].name)
    ) {
      throw new Error("Legacy recovery allows only a final handoff failure");
    }
  }
  return { modern };
}

export async function sourceArtifacts(repo, runId) {
  if (!RUN_ID_PATTERN.test(String(runId))) {
    throw new Error("Invalid source run ID");
  }
  const run = await api(`repos/${repo}/actions/runs/${runId}`);
  const jobs = await api(
    `repos/${repo}/actions/runs/${runId}/jobs?per_page=100`
  );
  const kind = validateSourceRun(run, jobs.jobs);
  const artifacts = await api(
    `repos/${repo}/actions/runs/${runId}/artifacts?per_page=100`
  );
  return { run, ...kind, artifacts: artifacts.artifacts };
}

export function exactArtifact(artifacts, name) {
  const found = artifacts.filter(
    (artifact) => artifact.name === name && !artifact.expired
  );
  if (found.length !== 1) {
    throw new Error(`Expected one unexpired artifact: ${name}`);
  }
  return found[0];
}

export async function githubRecords(root, manifest) {
  return [
    ...(await downloadRecords(root, manifest)),
    {
      ...(await readFileRecord(path.join(root, "github", "RELEASES"))),
      name: "RELEASES",
    },
  ];
}

export async function verifyAsset(asset, record, { fetchFn = fetch } = {}) {
  if (asset.size !== record.size || asset.state !== "uploaded") {
    throw new Error(`GitHub asset size/state mismatch: ${record.name}`);
  }
  if (asset.digest) {
    if (asset.digest !== `sha256:${record.sha256}`) {
      throw new Error(`GitHub asset digest mismatch: ${record.name}`);
    }
    return;
  }
  const response = await fetchFn(asset.url, {
    headers: {
      Accept: "application/octet-stream",
      Authorization: `Bearer ${process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN}`,
    },
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    throw new Error(`GitHub asset download failed: ${response.status}`);
  }
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    hash.update(chunk);
  }
  if (size !== record.size || hash.digest("hex") !== record.sha256) {
    throw new Error(`GitHub asset bytes mismatch: ${record.name}`);
  }
}

export async function stageGitHub(repo, root, manifest) {
  let release = await findRelease(repo, manifest.tag);
  const body =
    !release || release.draft ? await loadReleaseNotes(manifest) : null;
  if (!release) {
    release = await api(`repos/${repo}/releases`, {
      method: "POST",
      body: {
        tag_name: manifest.tag,
        target_commitish: manifest.commit,
        name: `AI Image Manager ${manifest.tag}`,
        body,
        draft: true,
      },
    });
  }
  if (release.draft && release.body !== body) {
    await api(`repos/${repo}/releases/${release.id}`, {
      method: "PATCH",
      body: { body },
    });
  }
  for (const record of await githubRecords(root, manifest)) {
    const name = record.name.replaceAll(" ", ".");
    const existing = release.assets.find((asset) => asset.name === name);
    if (existing) {
      await verifyAsset(existing, record);
      continue;
    }
    if (!release.draft) {
      throw new Error(
        `Published release is missing ${name}; refusing to alter it`
      );
    }
    console.error(`GitHub uploading ${name} (${record.size} bytes)`);
    const uploadRoute =
      release.upload_url.replace(UPLOAD_TEMPLATE_PATTERN, "") +
      `?name=${encodeURIComponent(name)}`;
    const result = await command(
      "gh",
      [
        "api",
        "--method",
        "POST",
        uploadRoute,
        "--header",
        "Content-Type: application/octet-stream",
        "--input",
        record.sourcePath,
      ],
      { timeoutMs: 10 * 60_000 }
    );
    const asset = JSON.parse(result);
    await verifyAsset(asset, record);
  }
  return release.id;
}

export async function finalizeGitHub(repo, root, manifest) {
  const latest = await api(`repos/${repo}/releases/latest`);
  const latestVersion = latest.tag_name.replace(TAG_PREFIX_PATTERN, "");
  if (
    !isStableVersion(latestVersion) ||
    compareVersions(latestVersion, manifest.version) > 0
  ) {
    throw new Error(
      "Refusing to replace a newer or unrecognized latest GitHub release"
    );
  }
  const release = await findRelease(repo, manifest.tag);
  if (!release) {
    throw new Error("GitHub release has not been staged");
  }
  for (const record of await githubRecords(root, manifest)) {
    const asset = release.assets.find(
      (item) => item.name === record.name.replaceAll(" ", ".")
    );
    if (!asset) {
      throw new Error(`Missing GitHub release asset: ${record.name}`);
    }
    await verifyAsset(asset, record);
  }
  if (release.draft || release.prerelease) {
    validateReleaseNotes(release.body);
    await api(`repos/${repo}/releases/${release.id}`, {
      method: "PATCH",
      body: { draft: false, prerelease: false, make_latest: "true" },
    });
  }
  console.log(`GitHub release published: ${release.html_url}`);
}
