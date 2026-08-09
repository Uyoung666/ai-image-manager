export type DiagnosticIncidentSource =
  | "manual"
  | "renderer-error"
  | "renderer-crash"
  | "worker-crash"
  | "main-crash"
  | "startup-failure"
  | "native-crash";

export type DiagnosticReproducibility = "always" | "sometimes" | "once";

export interface DiagnosticIncidentSummary {
  fingerprint: string;
  hasNativeDump: boolean;
  id: string;
  occurredAt: string;
  source: DiagnosticIncidentSource;
  summary: string;
}

export interface DiagnosticsOverview {
  logSizeBytes: number;
  nativeDumpAvailable: boolean;
  pendingIncidents: DiagnosticIncidentSummary[];
}

export interface RecordRendererIncidentInput {
  action?: string;
  componentStack?: string;
  message: string;
  route?: string;
  source?: "renderer-error";
  stack?: string;
}

export interface DiagnosticBundleInput {
  actualBehavior?: string;
  incidentId?: string;
  includeNativeDump?: boolean;
  lastAction: string;
  reproducibility: DiagnosticReproducibility;
}

export interface DiagnosticBundleResult {
  bundlePath: string;
  fingerprint: string;
  incidentId: string;
  includedFiles: string[];
  issueBody: string;
  issueUrl: string;
  nativeDumpIncluded: boolean;
  warnings: string[];
}
