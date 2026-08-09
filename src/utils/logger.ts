import pino from "pino";
import { createDiagnosticPinoStream } from "@/services/diagnostics/logging";

export const logger = pino(
  {
    level: process.env.LOG_LEVEL || "info",
    formatters: {
      level: (label) => ({ level: label }),
    },
    base: { process: "main" },
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  createDiagnosticPinoStream()
);

/** Create a structured child logger for one app module. */
export function createLogger(module: string) {
  return logger.child({ module });
}
