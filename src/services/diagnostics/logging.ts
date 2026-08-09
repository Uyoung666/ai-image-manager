import fs from "node:fs";
import path from "node:path";
import { Writable } from "node:stream";
import { app } from "electron";
import { createIncidentId } from "./incidents";
import { DiagnosticSanitizer } from "./sanitizer";

const MAX_LOG_BYTES = 5 * 1024 * 1024;
const MAX_LOG_FILES = 5;
const SESSION_ID = createIncidentId().replace(/^AIM-/, "SESSION-");
const APP_LOG_FILENAME_PATTERN = /^app(?:\.\d+)?\.log$/;
const MAX_RECORD_CHARS = 32_768;
const LOG_SANITIZER = new DiagnosticSanitizer();

export interface DiagnosticLogRecord {
  action?: string;
  incidentId?: string;
  level: "debug" | "info" | "warn" | "error" | "fatal";
  message: string;
  module?: string;
  process: "main" | "renderer" | "worker";
  route?: string;
  source?: string;
  stack?: string;
}

export function getDiagnosticLogFile(): string {
  return path.join(app.getPath("userData"), "logs", "app.log");
}

export function getDiagnosticLogSize(): number {
  const directory = path.dirname(getDiagnosticLogFile());
  if (!fs.existsSync(directory)) {
    return 0;
  }
  return fs
    .readdirSync(directory)
    .filter((name) => APP_LOG_FILENAME_PATTERN.test(name))
    .reduce((total, name) => {
      try {
        return total + fs.statSync(path.join(directory, name)).size;
      } catch {
        return total;
      }
    }, 0);
}

export function appendDiagnosticLog(record: DiagnosticLogRecord): void {
  writeDiagnosticLine(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      sessionId: SESSION_ID,
      ...record,
      action: sanitizeOptional(record.action, 64),
      message: LOG_SANITIZER.sanitize(record.message).slice(
        0,
        MAX_RECORD_CHARS
      ),
      module: sanitizeOptional(record.module, 128),
      route: sanitizeOptional(record.route, 256),
      source: sanitizeOptional(record.source, 512),
      stack: sanitizeOptional(record.stack, MAX_RECORD_CHARS),
    })
  );
}

export function createDiagnosticPinoStream(): NodeJS.WritableStream {
  return new Writable({
    write(chunk, _encoding, callback) {
      try {
        writeDiagnosticLine(normalizePinoLine(String(chunk).trimEnd()));
        callback();
      } catch (error) {
        callback(error as Error);
      }
    },
  });
}

export function installConsoleDiagnostics(): void {
  const globalState = globalThis as typeof globalThis & {
    __aimConsoleDiagnosticsInstalled?: boolean;
  };
  if (globalState.__aimConsoleDiagnosticsInstalled) {
    return;
  }
  globalState.__aimConsoleDiagnosticsInstalled = true;
  for (const level of ["info", "log", "warn", "error"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      try {
        appendDiagnosticLog({
          level: level === "log" ? "info" : level,
          message: args.map(formatConsoleValue).join(" "),
          module: "console",
          process: "main",
        });
      } catch {
        // Never recurse into console from diagnostic logging.
      }
    };
  }
}

function writeDiagnosticLine(line: string): void {
  const file = getDiagnosticLogFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  rotateIfNeeded(file, Buffer.byteLength(line, "utf8") + 1);
  fs.appendFileSync(file, `${line}\n`, "utf8");
}

function rotateIfNeeded(file: string, incomingBytes: number): void {
  let currentSize = 0;
  try {
    currentSize = fs.statSync(file).size;
  } catch {
    return;
  }
  if (currentSize + incomingBytes <= MAX_LOG_BYTES) {
    return;
  }
  for (let index = MAX_LOG_FILES - 1; index >= 1; index -= 1) {
    const target = path.join(path.dirname(file), `app.${index}.log`);
    const source =
      index === 1
        ? file
        : path.join(path.dirname(file), `app.${index - 1}.log`);
    try {
      if (fs.existsSync(source)) {
        fs.rmSync(target, { force: true });
        fs.renameSync(source, target);
      }
    } catch {
      // A locked log should not prevent the current operation from continuing.
    }
  }
}

function normalizePinoLine(line: string): string {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    const normalized = JSON.stringify({ sessionId: SESSION_ID, ...parsed });
    return LOG_SANITIZER.sanitize(normalized);
  } catch {
    return JSON.stringify({
      timestamp: new Date().toISOString(),
      sessionId: SESSION_ID,
      level: "info",
      message: LOG_SANITIZER.sanitize(line).slice(0, MAX_RECORD_CHARS),
      module: "pino",
      process: "main",
    });
  }
}

function sanitizeOptional(value: string | undefined, limit: number) {
  return value ? LOG_SANITIZER.sanitize(value).slice(0, limit) : undefined;
}

function formatConsoleValue(value: unknown): string {
  if (value instanceof Error) {
    return value.stack ?? value.message;
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
