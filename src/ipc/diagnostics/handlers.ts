import { os } from "@orpc/server";
import { z } from "zod";
import {
  getDiagnosticsOverview as buildOverview,
  createDiagnosticBundle as createBundle,
  dismissStoredIncident,
  getDiagnosticLogSize,
  recordDiagnosticIncident,
} from "@/services/diagnostics";
import { appendDiagnosticLog } from "@/services/diagnostics/logging";

const reproducibilitySchema = z.enum(["always", "sometimes", "once"]);

export const getDiagnosticsOverview = os.handler(() => {
  return buildOverview(getDiagnosticLogSize());
});

export const recordRendererIncident = os
  .input(
    z.object({
      action: z.string().max(64).optional(),
      message: z.string().min(1).max(4096),
      stack: z.string().max(32_768).optional(),
      componentStack: z.string().max(16_384).optional(),
      route: z.string().max(256).optional(),
      source: z.literal("renderer-error").optional(),
    })
  )
  .handler(({ input }) => {
    const incident = recordDiagnosticIncident({
      source: "renderer-error",
      action: input.action,
      message: input.message,
      stack: input.stack,
      componentStack: input.componentStack,
      route: input.route,
    });
    appendDiagnosticLog({
      action: input.action,
      incidentId: incident.id,
      level: "error",
      message: incident.message,
      module: "renderer-incident",
      process: "renderer",
      route: incident.route,
      stack: incident.stack,
    });
    return {
      id: incident.id,
      fingerprint: incident.fingerprint,
      occurredAt: incident.occurredAt,
    };
  });

export const createDiagnosticsBundle = os
  .input(
    z.object({
      incidentId: z.string().max(64).optional(),
      lastAction: z.string().min(1).max(4000),
      actualBehavior: z.string().max(4000).optional(),
      reproducibility: reproducibilitySchema,
      includeNativeDump: z.boolean().optional().default(false),
    })
  )
  .handler(({ input }) => createBundle(input));

export const dismissDiagnosticIncident = os
  .input(z.object({ incidentId: z.string().min(1).max(64) }))
  .handler(({ input }) => ({
    dismissed: dismissStoredIncident(input.incidentId),
  }));
