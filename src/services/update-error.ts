import { appendDiagnosticLog } from "@/services/diagnostics/logging";
import { classifyUpdateError, updateErrorText } from "@/utils/update-error";

export function recordUpdateError(error: unknown, action: string) {
  const code = classifyUpdateError(error);
  try {
    appendDiagnosticLog({
      action,
      level: "warn",
      message: updateErrorText(error),
      module: "updater",
      process: "main",
      stack: error instanceof Error ? error.stack : undefined,
    });
  } catch {
    // A diagnostic write failure must not leave the updater locked.
  }
  return code;
}
