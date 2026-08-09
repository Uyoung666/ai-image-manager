import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { app } from "electron";
import type {
  DiagnosticBundleInput,
  DiagnosticBundleResult,
  DiagnosticReproducibility,
} from "@/types/diagnostics";
import {
  findStoredIncident,
  recordDiagnosticIncident,
  type StoredDiagnosticIncident,
} from "./incidents";
import {
  containsPotentialSensitiveData,
  DiagnosticSanitizer,
} from "./sanitizer";

const MAX_DIAGNOSTIC_LOG_BYTES = 2 * 1024 * 1024;
const PROBE_TIMEOUT_MS = 1500;
const GITHUB_ISSUES_URL =
  "https://github.com/Uyoung666/ai-image-manager/issues/new";
const LINE_BREAK_PATTERN = /\r?\n/;
const MAX_ISSUE_URL_CHARS = 7500;

interface BundleEntries {
  logs: string;
  manifest: Record<string, unknown>;
  report: string;
  warnings: string[];
}

interface ZipArchiveInstance {
  append(source: string, data: { name: string }): this;
  file(filename: string, data: { name: string }): this;
  finalize(): Promise<void>;
  on(event: "error" | "warning", listener: (error: Error) => void): this;
  pipe(destination: NodeJS.WritableStream): NodeJS.WritableStream;
}

export async function createDiagnosticBundle(
  input: DiagnosticBundleInput
): Promise<DiagnosticBundleResult> {
  const incident = resolveIncident(input);
  const entries = await assembleDiagnosticEntries(incident, input);
  const outputPath = getUniqueBundlePath(incident.id);
  const partialPath = `${outputPath}.partial`;
  const includedFiles = ["report.md", "manifest.json", "logs/app.log"];
  let nativeDumpIncluded = false;

  const output = fs.createWriteStream(partialPath, { flags: "wx" });
  const archiveModule = (await import("archiver")) as unknown as {
    ZipArchive: new (options: {
      zlib: { level: number };
    }) => ZipArchiveInstance;
  };
  const archive = new archiveModule.ZipArchive({ zlib: { level: 9 } });
  const closePromise = once(output, "close");
  archive.on("warning", (error) => {
    entries.warnings.push(error.message);
  });
  archive.on("error", (error) => {
    output.destroy(error);
  });
  archive.pipe(output);
  archive.append(entries.report, { name: "report.md" });
  archive.append(JSON.stringify(entries.manifest, null, 2), {
    name: "manifest.json",
  });
  archive.append(entries.logs, { name: "logs/app.log" });

  if (input.includeNativeDump && incident.nativeDumpPath) {
    if (fs.existsSync(incident.nativeDumpPath)) {
      const nativeDumpEntry = `crash/${path.basename(incident.nativeDumpPath)}`;
      archive.file(incident.nativeDumpPath, {
        name: nativeDumpEntry,
      });
      includedFiles.push(nativeDumpEntry);
      nativeDumpIncluded = true;
    } else {
      entries.warnings.push("The native crash dump is no longer available.");
    }
  }

  try {
    await Promise.all([archive.finalize(), closePromise]);
    fs.renameSync(partialPath, outputPath);
  } catch (error) {
    try {
      if (fs.existsSync(partialPath)) {
        fs.rmSync(partialPath, { force: true });
      }
    } catch {
      // Only our own incomplete output is eligible for cleanup.
    }
    throw error;
  }

  const { issueBody, issueUrl } = buildGitHubIssue({
    incident,
    input,
    manifest: entries.manifest,
  });
  return {
    incidentId: incident.id,
    fingerprint: incident.fingerprint,
    bundlePath: outputPath,
    issueUrl,
    issueBody,
    warnings: entries.warnings,
    includedFiles,
    nativeDumpIncluded,
  };
}

export async function assembleDiagnosticEntries(
  incident: StoredDiagnosticIncident,
  input: DiagnosticBundleInput
): Promise<BundleEntries> {
  const sanitizer = new DiagnosticSanitizer();
  const warnings: string[] = [];
  const manifest = await collectManifest(incident, warnings);
  let logs = readRecentLogs(sanitizer);
  const forbiddenValues = getForbiddenValues();
  if (containsPotentialSensitiveData(logs, forbiddenValues)) {
    warnings.push(
      "Recent logs were omitted because the privacy self-check found unsanitized data."
    );
    logs = "Logs omitted: privacy self-check did not pass.\n";
  }
  let safeManifest = JSON.parse(sanitizer.sanitizeJson(manifest)) as Record<
    string,
    unknown
  >;
  let report = buildReport(incident, input, warnings, sanitizer);
  if (
    containsPotentialSensitiveData(
      JSON.stringify(safeManifest),
      forbiddenValues
    ) ||
    containsPotentialSensitiveData(report, forbiddenValues)
  ) {
    warnings.push(
      "The detailed report was reduced because the final privacy self-check did not pass."
    );
    logs = "Logs omitted: the bundle was reduced by the privacy self-check.\n";
    safeManifest = createMinimalManifest(incident);
    report = createMinimalReport(incident);
  }
  return { logs, manifest: safeManifest, report, warnings };
}

export function buildGitHubIssue({
  incident,
  input,
  manifest,
}: {
  incident: StoredDiagnosticIncident;
  input: DiagnosticBundleInput;
  manifest: Record<string, unknown>;
}): { issueBody: string; issueUrl: string } {
  const appInfo = manifest.app as Record<string, unknown> | undefined;
  const systemInfo = manifest.system as Record<string, unknown> | undefined;
  const version = String(appInfo?.version ?? app.getVersion());
  const title = `[Bug][v${version}][${incident.fingerprint}] 功能异常`;
  const issueBody = composeIssueBody({
    incident,
    input,
    systemInfo,
    version,
  });
  let issueUrl = `${GITHUB_ISSUES_URL}?${new URLSearchParams({ title, body: issueBody }).toString()}`;
  let userTextLimit = 400;
  while (issueUrl.length > MAX_ISSUE_URL_CHARS && userTextLimit >= 50) {
    const compactBody = composeIssueBody({
      incident,
      input,
      systemInfo,
      userTextLimit,
      version,
    });
    issueUrl = `${GITHUB_ISSUES_URL}?${new URLSearchParams({ title, body: compactBody }).toString()}`;
    userTextLimit = Math.floor(userTextLimit / 2);
  }
  if (issueUrl.length > MAX_ISSUE_URL_CHARS) {
    const minimalBody = [
      `Incident: ${incident.id}`,
      `Fingerprint: ${incident.fingerprint}`,
      `Version: ${version}`,
      "",
      "请把软件已选中的诊断 ZIP 拖到这里。",
      "Drag the ZIP highlighted by the app here.",
    ].join("\n");
    issueUrl = `${GITHUB_ISSUES_URL}?${new URLSearchParams({ title, body: minimalBody }).toString()}`;
  }
  return { issueBody, issueUrl };
}

function composeIssueBody({
  incident,
  input,
  systemInfo,
  userTextLimit,
  version,
}: {
  incident: StoredDiagnosticIncident;
  input: DiagnosticBundleInput;
  systemInfo: Record<string, unknown> | undefined;
  userTextLimit?: number;
  version: string;
}): string {
  return [
    "## 问题描述 / Problem",
    truncateIssueText(
      input.actualBehavior?.trim() || "（请补充看到的异常表现）",
      userTextLimit
    ),
    "",
    "## 出错前最后一步 / Last action",
    truncateIssueText(input.lastAction.trim(), userTextLimit),
    "",
    "## 出现频率 / Frequency",
    reproducibilityLabel(input.reproducibility),
    "",
    "## 诊断信息 / Diagnostics",
    `- 事件编号 / Incident: ${incident.id}`,
    `- 错误指纹 / Fingerprint: ${incident.fingerprint}`,
    `- 版本 / Version: ${version}`,
    `- 系统 / OS: ${String(systemInfo?.platform ?? process.platform)} ${String(systemInfo?.release ?? os.release())} ${String(systemInfo?.arch ?? process.arch)}`,
    "",
    "## 诊断包 / Diagnostic bundle",
    "请把软件已在资源管理器中选中的 ZIP 文件拖到这里。",
    "Drag the ZIP highlighted by the app here.",
    "",
    "<!-- 诊断包不会自动上传；提交前可自行检查附件。 -->",
  ].join("\n");
}

function truncateIssueText(value: string, limit?: number): string {
  if (!limit || value.length <= limit) {
    return value;
  }
  return `${value.slice(0, limit)}\n…（预填内容已截断，完整描述保留在诊断包中）`;
}

function resolveIncident(
  input: DiagnosticBundleInput
): StoredDiagnosticIncident {
  if (input.incidentId) {
    const existing = findStoredIncident(input.incidentId);
    if (existing) {
      return existing;
    }
  }
  return recordDiagnosticIncident({
    source: "manual",
    message: input.actualBehavior?.trim() || "Manual diagnostic report",
  });
}

async function collectManifest(
  incident: StoredDiagnosticIncident,
  warnings: string[]
): Promise<Record<string, unknown>> {
  const probes: Record<string, unknown> = {};
  try {
    probes.database = await withTimeout(
      collectDatabaseSummary(),
      PROBE_TIMEOUT_MS
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    probes.database = { status: "error", detail: message };
    warnings.push(`Database summary unavailable: ${message}`);
  }
  try {
    probes.gpu = await withTimeout(collectGpuSummary(), PROBE_TIMEOUT_MS);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    probes.gpu = { status: "error", detail: message };
    warnings.push(`GPU summary unavailable: ${message}`);
  }

  const cpu = os.cpus()[0];
  let diskAvailableBytes: number | null = null;
  try {
    const stats = fs.statfsSync(app.getPath("userData"));
    diskAvailableBytes = stats.bavail * stats.bsize;
  } catch {
    // Storage metadata is best-effort.
  }
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    incident: {
      id: incident.id,
      fingerprint: incident.fingerprint,
      occurredAt: incident.occurredAt,
      source: incident.source,
      summary: incident.message.split(LINE_BREAK_PATTERN, 1)[0],
    },
    app: {
      name: app.getName(),
      version: app.getVersion(),
      packaged: app.isPackaged,
      locale: safeAppLocale(),
      runtime: {
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
      },
    },
    system: {
      platform: process.platform,
      release: os.release(),
      arch: process.arch,
      cpu: cpu?.model ?? "unknown",
      logicalCpuCount: os.cpus().length,
      memoryGiB: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
      diskAvailableBytes,
    },
    probes,
    privacy: {
      mode: "strict",
      excludes: [
        "photos",
        "thumbnails",
        "database files",
        "face and vector data",
        "EXIF content",
        "cloud credentials",
      ],
      nativeDumpIncludedByDefault: false,
    },
  };
}

async function collectDatabaseSummary(): Promise<Record<string, unknown>> {
  const [{ getDatabase }, { photos }] = await Promise.all([
    import("@/db"),
    import("@/db/schema"),
  ]);
  const database = getDatabase();
  const result = database
    .select({
      aiProcessed: sql<number>`sum(case when ${photos.isAiProcessed} = 1 then 1 else 0 end)`,
      faceProcessed: sql<number>`sum(case when ${photos.isFaceProcessed} = 1 then 1 else 0 end)`,
      indexed: sql<number>`sum(case when ${photos.isIndexed} = 1 then 1 else 0 end)`,
      photoRecords: sql<number>`count(*)`,
    })
    .from(photos)
    .get();
  return {
    status: "ok",
    photoRecords: result?.photoRecords ?? 0,
    indexedPhotoRecords: result?.indexed ?? 0,
    aiProcessedPhotoRecords: result?.aiProcessed ?? 0,
    faceProcessedPhotoRecords: result?.faceProcessed ?? 0,
  };
}

async function collectGpuSummary(): Promise<Record<string, unknown>> {
  const info = (await app.getGPUInfo("basic")) as {
    gpuDevice?: Array<{
      active?: boolean;
      deviceId?: number;
      driverVendor?: string;
      driverVersion?: string;
      vendorId?: number;
    }>;
  };
  const devices = Array.isArray(info.gpuDevice)
    ? info.gpuDevice.map((device) => ({
        active: device.active,
        vendorId: device.vendorId,
        deviceId: device.deviceId,
        driverVendor: device.driverVendor,
        driverVersion: device.driverVersion,
      }))
    : [];
  return {
    status: "ok",
    devices,
    featureStatus: app.getGPUFeatureStatus(),
  };
}

function buildReport(
  incident: StoredDiagnosticIncident,
  input: DiagnosticBundleInput,
  warnings: string[],
  sanitizer: DiagnosticSanitizer
): string {
  return [
    "# AI Image Manager Diagnostic Report",
    "",
    `- Incident: ${incident.id}`,
    `- Fingerprint: ${incident.fingerprint}`,
    `- Occurred at: ${incident.occurredAt}`,
    `- Source: ${incident.source}`,
    "",
    "## Last action",
    sanitizer.sanitize(input.lastAction.trim()),
    "",
    "## Actual behavior",
    input.actualBehavior?.trim()
      ? sanitizer.sanitize(input.actualBehavior.trim())
      : sanitizer.sanitize(incident.message),
    "",
    "## Frequency",
    reproducibilityLabel(input.reproducibility),
    "",
    "## Privacy",
    "Strict redaction is enabled. Photos, databases, EXIF, face/vector data and credentials are excluded.",
    ...(warnings.length > 0
      ? [
          "",
          "## Warnings",
          ...warnings.map((warning) => `- ${sanitizer.sanitize(warning)}`),
        ]
      : []),
    "",
  ].join("\n");
}

function readRecentLogs(sanitizer: DiagnosticSanitizer): string {
  const logDirectory = path.join(app.getPath("userData"), "logs");
  if (!fs.existsSync(logDirectory)) {
    return "No diagnostic logs were found.\n";
  }
  const preferredNames = [
    "app.log",
    "app.1.log",
    "app.2.log",
    "app.3.log",
    "app.4.log",
    "main.log",
    "error.log",
    "crash.log",
    "startup.log",
    "whenReady.log",
    "ai-worker.log",
    "ipc-error.log",
    "migrate.log",
  ];
  const chunks: string[] = [];
  let remaining = MAX_DIAGNOSTIC_LOG_BYTES;
  for (const name of preferredNames) {
    const file = path.join(logDirectory, name);
    if (!fs.existsSync(file) || remaining <= 0) {
      continue;
    }
    try {
      const stats = fs.statSync(file);
      const bytesToRead = Math.min(stats.size, MAX_DIAGNOSTIC_LOG_BYTES);
      if (bytesToRead <= 0) {
        continue;
      }
      const buffer = Buffer.alloc(bytesToRead);
      const handle = fs.openSync(file, "r");
      try {
        fs.readSync(
          handle,
          buffer,
          0,
          bytesToRead,
          Math.max(0, stats.size - bytesToRead)
        );
      } finally {
        fs.closeSync(handle);
      }
      const sourceOffset = Math.max(0, stats.size - bytesToRead);
      const lines = buffer.toString("utf8").split(LINE_BREAK_PATTERN);
      if (sourceOffset > 0) {
        lines.shift();
      }
      const selection = selectRecentLogLines(lines, name, sanitizer, remaining);
      chunks.push(selection.chunk);
      remaining -= selection.bytes;
    } catch {
      // Continue collecting other logs if one file is locked or unreadable.
    }
  }
  const combined = chunks.join("");
  return combined || "No readable diagnostic logs were found.\n";
}

function selectRecentLogLines(
  lines: string[],
  sourceName: string,
  sanitizer: DiagnosticSanitizer,
  budget: number
): { bytes: number; chunk: string } {
  const selected: string[] = [];
  let bytes = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const rawLine = lines[index]?.trim();
    if (!rawLine) {
      continue;
    }
    const normalized = normalizeDiagnosticLogLine(
      rawLine,
      sourceName,
      sanitizer
    );
    const serialized = `${normalized}\n`;
    const size = Buffer.byteLength(serialized, "utf8");
    if (size > budget - bytes) {
      continue;
    }
    selected.push(serialized);
    bytes += size;
  }
  return { bytes, chunk: selected.reverse().join("") };
}

function normalizeDiagnosticLogLine(
  rawLine: string,
  sourceName: string,
  sanitizer: DiagnosticSanitizer
): string {
  const sanitized = sanitizer.sanitize(rawLine);
  try {
    return JSON.stringify(JSON.parse(sanitized));
  } catch {
    return JSON.stringify({
      level: "info",
      message: sanitized,
      module: `legacy-${sourceName}`,
      process: "legacy",
    });
  }
}

function getForbiddenValues(): string[] {
  const values = [
    os.homedir(),
    os.hostname(),
    os.userInfo().username,
    app.getPath("home"),
    app.getPath("userData"),
    process.env.COMPUTERNAME ?? "",
    process.env.USERNAME ?? "",
  ];
  try {
    const configPath = path.join(app.getPath("userData"), "app-config.json");
    if (fs.existsSync(configPath)) {
      const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
        dataPath?: unknown;
      };
      if (typeof parsed.dataPath === "string") {
        values.push(parsed.dataPath);
      }
    }
  } catch {
    // A malformed config must not block diagnostics.
  }
  return values;
}

function getUniqueBundlePath(incidentId: string): string {
  const directory = app.getPath("downloads");
  fs.mkdirSync(directory, { recursive: true });
  const baseName = `AI-Image-Manager-Diagnostics-${incidentId}`;
  let candidate = path.join(directory, `${baseName}.zip`);
  let suffix = 2;
  while (fs.existsSync(candidate) || fs.existsSync(`${candidate}.partial`)) {
    candidate = path.join(directory, `${baseName}-${suffix}.zip`);
    suffix += 1;
  }
  return candidate;
}

function createMinimalManifest(
  incident: StoredDiagnosticIncident
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    incident: {
      fingerprint: incident.fingerprint,
      id: incident.id,
      occurredAt: incident.occurredAt,
      source: incident.source,
    },
    privacy: { mode: "strict-minimal" },
  };
}

function createMinimalReport(incident: StoredDiagnosticIncident): string {
  return [
    "# AI Image Manager Minimal Diagnostic Report",
    "",
    `- Incident: ${incident.id}`,
    `- Fingerprint: ${incident.fingerprint}`,
    "",
    "Detailed diagnostics were omitted because the final privacy self-check did not pass.",
    "",
  ].join("\n");
}

function safeAppLocale(): string {
  try {
    return app.getLocale();
  } catch {
    return Intl.DateTimeFormat().resolvedOptions().locale;
  }
}

function reproducibilityLabel(value: DiagnosticReproducibility): string {
  const labels: Record<DiagnosticReproducibility, string> = {
    always: "总是 / Always",
    sometimes: "偶尔 / Sometimes",
    once: "仅一次 / Once",
  };
  return labels[value];
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Probe timed out")),
          timeoutMs
        );
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
