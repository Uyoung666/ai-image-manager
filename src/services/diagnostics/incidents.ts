import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import type {
  DiagnosticIncidentSource,
  DiagnosticIncidentSummary,
  DiagnosticsOverview,
} from "@/types/diagnostics";
import { DiagnosticSanitizer, sanitizeRendererRoute } from "./sanitizer";

const MAX_INCIDENTS = 20;
const INCIDENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const LINE_BREAK_PATTERN = /\r?\n/;

export interface StoredDiagnosticIncident {
  action?: string;
  componentStack?: string;
  dismissedAt?: string;
  fingerprint: string;
  id: string;
  message: string;
  nativeDumpPath?: string;
  occurredAt: string;
  route?: string;
  source: DiagnosticIncidentSource;
  stack?: string;
}

export function getDiagnosticsDir(): string {
  return path.join(app.getPath("userData"), "diagnostics");
}

export function getIncidentsFile(): string {
  return path.join(getDiagnosticsDir(), "incidents.jsonl");
}

export function createIncidentId(date = new Date()): string {
  const stamp = date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace("T", "-")
    .slice(0, 15);
  return `AIM-${stamp}-${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
}

export function createErrorFingerprint(
  message: string,
  stack?: string
): string {
  const normalized = `${message}\n${stack ?? ""}`
    .replace(/[a-zA-Z]:\\[^\r\n)]+/g, "<PATH>")
    .replace(/\\\\[^\r\n)]+/g, "<PATH>")
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "<ID>")
    .replace(/:\d+:\d+/g, ":<LINE>")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return crypto
    .createHash("sha256")
    .update(normalized)
    .digest("hex")
    .slice(0, 12);
}

export function recordDiagnosticIncident(input: {
  action?: string;
  componentStack?: string;
  message: string;
  nativeDumpPath?: string;
  route?: string;
  source: DiagnosticIncidentSource;
  stack?: string;
}): StoredDiagnosticIncident {
  const sanitizer = new DiagnosticSanitizer();
  const incident: StoredDiagnosticIncident = {
    id: createIncidentId(),
    fingerprint: createErrorFingerprint(input.message, input.stack),
    occurredAt: new Date().toISOString(),
    source: input.source,
    action: input.action?.slice(0, 64),
    message: sanitizer.sanitize(input.message).slice(0, 4096),
    stack: input.stack
      ? sanitizer.sanitize(input.stack).slice(0, 32_768)
      : undefined,
    componentStack: input.componentStack
      ? sanitizer.sanitize(input.componentStack).slice(0, 16_384)
      : undefined,
    route: input.route ? sanitizeRendererRoute(input.route) : undefined,
    nativeDumpPath: input.nativeDumpPath,
  };
  appendIncident(incident);
  return incident;
}

export function appendIncident(incident: StoredDiagnosticIncident): void {
  const directory = getDiagnosticsDir();
  fs.mkdirSync(directory, { recursive: true });
  fs.appendFileSync(
    getIncidentsFile(),
    `${JSON.stringify(incident)}\n`,
    "utf8"
  );
}

export function listStoredIncidents(): StoredDiagnosticIncident[] {
  discoverNativeCrashDumps();
  const file = getIncidentsFile();
  if (!fs.existsSync(file)) {
    return [];
  }
  const latestById = new Map<string, StoredDiagnosticIncident>();
  for (const line of fs.readFileSync(file, "utf8").split(LINE_BREAK_PATTERN)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as StoredDiagnosticIncident;
      if (parsed.id && parsed.occurredAt) {
        latestById.set(parsed.id, parsed);
      }
    } catch {
      // A partial final line after a crash is intentionally ignored.
    }
  }
  const cutoff = Date.now() - INCIDENT_RETENTION_MS;
  const incidents = [...latestById.values()]
    .filter((incident) => Date.parse(incident.occurredAt) >= cutoff)
    .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))
    .slice(0, MAX_INCIDENTS);
  compactIncidentsFile(incidents);
  return incidents;
}

export function findStoredIncident(
  id: string
): StoredDiagnosticIncident | undefined {
  return listStoredIncidents().find((incident) => incident.id === id);
}

export function dismissStoredIncident(id: string): boolean {
  const incident = findStoredIncident(id);
  if (!incident) {
    return false;
  }
  appendIncident({ ...incident, dismissedAt: new Date().toISOString() });
  return true;
}

export function getDiagnosticsOverview(
  logSizeBytes: number
): DiagnosticsOverview {
  const incidents = listStoredIncidents().filter(
    (incident) => !incident.dismissedAt
  );
  const pendingIncidents = incidents.map(toIncidentSummary);
  return {
    logSizeBytes,
    nativeDumpAvailable: pendingIncidents.some((item) => item.hasNativeDump),
    pendingIncidents,
  };
}

function toIncidentSummary(
  incident: StoredDiagnosticIncident
): DiagnosticIncidentSummary {
  const sanitizer = new DiagnosticSanitizer();
  return {
    id: incident.id,
    fingerprint: incident.fingerprint,
    occurredAt: incident.occurredAt,
    source: incident.source,
    summary: sanitizer.sanitize(
      incident.message.split(LINE_BREAK_PATTERN, 1)[0] || "Unknown error"
    ),
    hasNativeDump: Boolean(incident.nativeDumpPath),
  };
}

function compactIncidentsFile(incidents: StoredDiagnosticIncident[]): void {
  const file = getIncidentsFile();
  const compacted = incidents
    .map((incident) => JSON.stringify(incident))
    .join("\n");
  try {
    fs.writeFileSync(file, compacted ? `${compacted}\n` : "", "utf8");
  } catch {
    // Diagnostics must never break the app because retention cleanup failed.
  }
}

function discoverNativeCrashDumps(): void {
  let crashDirectory: string;
  try {
    crashDirectory = app.getPath("crashDumps");
  } catch {
    return;
  }
  if (!fs.existsSync(crashDirectory)) {
    return;
  }
  const incidentFile = getIncidentsFile();
  const existingText = fs.existsSync(incidentFile)
    ? fs.readFileSync(incidentFile, "utf8")
    : "";
  const cutoff = Date.now() - INCIDENT_RETENTION_MS;
  for (const entry of fs.readdirSync(crashDirectory, { withFileTypes: true })) {
    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".dmp") {
      continue;
    }
    const dumpPath = path.join(crashDirectory, entry.name);
    if (existingText.includes(dumpPath)) {
      continue;
    }
    try {
      if (fs.statSync(dumpPath).mtimeMs < cutoff) {
        continue;
      }
      recordDiagnosticIncident({
        source: "native-crash",
        message: "A native process crash dump was detected",
        nativeDumpPath: dumpPath,
      });
    } catch {
      // Ignore crash dump files that disappear while being inspected.
    }
  }
}
