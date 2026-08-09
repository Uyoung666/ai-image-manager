import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app, crashReporter, dialog, shell } from "electron";

type BootstrapIncidentSource = "main-crash" | "startup-failure";
const LINE_BREAK_PATTERN = /\r?\n/;

const e2eUserDataDir = process.env.AI_IMAGE_MANAGER_E2E_USER_DATA_DIR;
if (process.env.CI === "e2e" && e2eUserDataDir) {
  app.setPath("userData", path.resolve(e2eUserDataDir));
  app.disableHardwareAcceleration();
}
const devUserDataDir = process.env.AI_IMAGE_MANAGER_USER_DATA_DIR;
if (devUserDataDir) {
  app.setPath("userData", path.resolve(devUserDataDir));
}

try {
  crashReporter.start({ uploadToServer: false, compress: false });
} catch {
  // Local crash dumps are best-effort; startup must continue without them.
}

let handlingFatalError = false;

function createIncidentId(): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace("T", "-")
    .slice(0, 15);
  return `AIM-${stamp}-${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
}

function normalizeError(reason: unknown): { message: string; stack?: string } {
  if (reason instanceof Error) {
    return { message: reason.message || reason.name, stack: reason.stack };
  }
  return { message: String(reason) };
}

function writePendingIncident(
  source: BootstrapIncidentSource,
  reason: unknown
): { id: string; message: string; stack?: string } {
  const error = normalizeError(reason);
  const id = createIncidentId();
  const normalized = `${error.message}\n${error.stack ?? ""}`
    .replace(/file:\/\/\/[^\r\n)]+/gi, "<PATH>")
    .replace(/[a-zA-Z]:[\\/][^\r\n)]+/g, "<PATH>")
    .replace(/:\d+:\d+/g, ":<LINE>")
    .toLowerCase();
  const fingerprint = crypto
    .createHash("sha256")
    .update(normalized)
    .digest("hex")
    .slice(0, 12);
  const existing = findPendingBootstrapIncident(source, fingerprint);
  if (existing) {
    return { id: existing.id, ...error };
  }
  const incident = {
    id,
    fingerprint,
    occurredAt: new Date().toISOString(),
    source,
    message: redactBootstrapText(error.message).slice(0, 4096),
    stack: error.stack
      ? redactBootstrapText(error.stack).slice(0, 32_768)
      : undefined,
  };
  try {
    const directory = path.join(app.getPath("userData"), "diagnostics");
    fs.mkdirSync(directory, { recursive: true });
    fs.appendFileSync(
      path.join(directory, "incidents.jsonl"),
      `${JSON.stringify(incident)}\n`,
      "utf8"
    );
    const logDirectory = path.join(app.getPath("userData"), "logs");
    fs.mkdirSync(logDirectory, { recursive: true });
    fs.appendFileSync(
      path.join(logDirectory, "crash.log"),
      `${incident.occurredAt} ${source} ${id}\n${incident.stack ?? incident.message}\n`,
      "utf8"
    );
  } catch {
    // The native dialog below remains available if disk logging fails.
  }
  return { id, ...error };
}

function findPendingBootstrapIncident(
  source: BootstrapIncidentSource,
  fingerprint: string
): { id: string } | undefined {
  try {
    const file = path.join(
      app.getPath("userData"),
      "diagnostics",
      "incidents.jsonl"
    );
    if (!fs.existsSync(file)) {
      return undefined;
    }
    const latestById = new Map<
      string,
      {
        dismissedAt?: string;
        fingerprint?: string;
        id?: string;
        source?: string;
      }
    >();
    for (const line of fs
      .readFileSync(file, "utf8")
      .split(LINE_BREAK_PATTERN)) {
      if (!line.trim()) {
        continue;
      }
      const parsed = JSON.parse(line) as {
        dismissedAt?: string;
        fingerprint?: string;
        id?: string;
        source?: string;
      };
      if (parsed.id) {
        latestById.set(parsed.id, parsed);
      }
    }
    for (const parsed of [...latestById.values()].reverse()) {
      if (
        parsed.id &&
        parsed.source === source &&
        parsed.fingerprint === fingerprint &&
        !parsed.dismissedAt
      ) {
        return { id: parsed.id };
      }
    }
  } catch {
    // The fatal path must continue even when the incident file is unreadable.
  }
  return undefined;
}

function redactBootstrapText(value: string): string {
  return value
    .replace(/file:\/\/\/[^\r\n)]+/gi, "<PATH>")
    .replace(/[a-zA-Z]:[\\/][^\r\n)]+/g, "<PATH>")
    .replace(/\\\\[^\r\n)]+/g, "<PATH>")
    .replace(/([\\/]Users[\\/])[^\\/\s]+/gi, "$1<USER>")
    .replace(
      /\b(token|password|secret|authorization|api[_-]?key)["']?\s*[:=]\s*[^\s,;}]+/gi,
      "$1=<REDACTED>"
    );
}

function writeMinimalReport(incident: {
  id: string;
  message: string;
  stack?: string;
}): string {
  const downloads = app.getPath("downloads");
  const baseName = `AI-Image-Manager-Diagnostics-${incident.id}`;
  let target = path.join(downloads, `${baseName}.txt`);
  let suffix = 2;
  while (fs.existsSync(target)) {
    target = path.join(downloads, `${baseName}-${suffix}.txt`);
    suffix += 1;
  }
  const text = [
    "AI Image Manager minimal startup diagnostic",
    `Incident: ${incident.id}`,
    `Version: ${app.getVersion()}`,
    `OS: ${process.platform} ${os.release()} ${process.arch}`,
    "",
    redactBootstrapText(incident.message),
    redactBootstrapText(incident.stack ?? ""),
    "",
    "This file was generated locally. It contains no photos or databases.",
  ].join("\n");
  fs.writeFileSync(target, text, "utf8");
  return target;
}

async function handleFatalError(
  source: BootstrapIncidentSource,
  reason: unknown
): Promise<void> {
  if (handlingFatalError) {
    return;
  }
  handlingFatalError = true;
  const incident = writePendingIncident(source, reason);
  try {
    await app.whenReady();
    const { response } = await dialog.showMessageBox({
      type: "error",
      title: "AI Image Manager",
      message: "软件遇到严重错误 / A fatal error occurred",
      detail: `事件编号 / Incident: ${incident.id}\n可立即生成最小诊断报告，或下次启动后前往“设置 → 帮助与诊断”。`,
      buttons: ["生成报告并反馈 / Generate & report", "退出 / Exit"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (response === 0) {
      const reportPath = writeMinimalReport(incident);
      const body = [
        "## 启动失败 / Startup failure",
        `- 事件编号 / Incident: ${incident.id}`,
        `- 版本 / Version: ${app.getVersion()}`,
        "",
        "请将资源管理器中选中的诊断 TXT 拖到这里。",
      ].join("\n");
      const issueUrl =
        "https://github.com/Uyoung666/ai-image-manager/issues/new?" +
        new URLSearchParams({
          title: `[Bug][v${app.getVersion()}] 启动失败`,
          body,
        }).toString();
      await Promise.allSettled([
        shell.openExternal(issueUrl),
        Promise.resolve(shell.showItemInFolder(reportPath)),
      ]);
    }
  } catch {
    try {
      dialog.showErrorBox(
        "AI Image Manager",
        `Fatal error. Incident: ${incident.id}`
      );
    } catch {
      // There is no further safe UI fallback.
    }
  } finally {
    app.exit(1);
  }
}

process.on("uncaughtException", (error) => {
  handleFatalError("main-crash", error);
});
process.on("unhandledRejection", (reason) => {
  handleFatalError("main-crash", reason);
});

import("./main").catch((error: unknown) =>
  handleFatalError("startup-failure", error)
);
