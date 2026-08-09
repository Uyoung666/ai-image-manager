import type { ChildProcess } from "node:child_process";
import { recordDiagnosticIncident } from "./incidents";
import { appendDiagnosticLog } from "./logging";

export function captureWorkerOutput(child: ChildProcess, module: string): void {
  let failureRecorded = false;
  const recordFailure = (message: string, stack?: string) => {
    if (failureRecorded) {
      return;
    }
    failureRecorded = true;
    recordWorkerFailure(module, message, stack);
  };
  child.stdout?.on("data", (chunk: Buffer | string) => {
    tryAppendDiagnosticLog({
      level: "info",
      message: String(chunk).trimEnd(),
      module,
      process: "worker",
      source: "stdout",
    });
  });
  child.stderr?.on("data", (chunk: Buffer | string) => {
    tryAppendDiagnosticLog({
      level: "error",
      message: String(chunk).trimEnd(),
      module,
      process: "worker",
      source: "stderr",
    });
  });
  child.on("error", (error) => {
    recordFailure(error.message, error.stack);
  });
  child.on("exit", (code) => {
    if (code === null || code === 0) {
      return;
    }
    recordFailure(`Worker exited with code ${code}`);
  });
}

function recordWorkerFailure(module: string, message: string, stack?: string) {
  let incidentId: string | undefined;
  try {
    incidentId = recordDiagnosticIncident({
      message,
      source: "worker-crash",
      stack,
    }).id;
  } catch {
    // Diagnostics are best-effort and must never alter worker lifecycle behavior.
  }
  tryAppendDiagnosticLog({
    incidentId,
    level: "error",
    message,
    module,
    process: "worker",
    source: "process-exit",
    stack,
  });
}

function tryAppendDiagnosticLog(
  record: Parameters<typeof appendDiagnosticLog>[0]
): void {
  try {
    appendDiagnosticLog(record);
  } catch {
    // Keep application behavior intact when diagnostic storage is unavailable.
  }
}
