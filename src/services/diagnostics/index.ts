// biome-ignore lint/performance/noBarrelFile: diagnostics exposes one deliberate main-process boundary.
export { createDiagnosticBundle } from "./bundle";
export {
  dismissStoredIncident,
  getDiagnosticsOverview,
  recordDiagnosticIncident,
} from "./incidents";
export {
  appendDiagnosticLog,
  createDiagnosticPinoStream,
  getDiagnosticLogSize,
  installConsoleDiagnostics,
} from "./logging";
