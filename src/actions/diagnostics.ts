import { ipc } from "@/ipc/manager";
import type {
  DiagnosticBundleInput,
  DiagnosticBundleResult,
  DiagnosticsOverview,
  RecordRendererIncidentInput,
} from "@/types/diagnostics";

export function getDiagnosticsOverview(): Promise<DiagnosticsOverview> {
  return ipc.client.diagnostics.getDiagnosticsOverview({});
}

export function recordRendererIncident(
  input: RecordRendererIncidentInput
): Promise<{ fingerprint: string; id: string; occurredAt: string }> {
  return ipc.client.diagnostics.recordRendererIncident(input);
}

export function createDiagnosticsBundle(
  input: DiagnosticBundleInput
): Promise<DiagnosticBundleResult> {
  return ipc.client.diagnostics.createDiagnosticsBundle(input);
}

export function dismissDiagnosticIncident(
  incidentId: string
): Promise<{ dismissed: boolean }> {
  return ipc.client.diagnostics.dismissDiagnosticIncident({ incidentId });
}
