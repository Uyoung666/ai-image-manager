export function duplicateErrorKey(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("SCAN_CANCELLED")) {
    return "duplicateScanCancelled";
  }
  if (message.includes("PLAN_EXPIRED")) {
    return "duplicatePlanExpired";
  }
  if (message.includes("SOURCE_MISSING")) {
    return "duplicateSourceMissing";
  }
  if (message.includes("FILE_CHANGED")) {
    return "duplicateFileChanged";
  }
  if (message.includes("VECTOR_UNAVAILABLE")) {
    return "duplicateVectorUnavailable";
  }
  if (message.includes("STALE_") || message.includes("stale")) {
    return "duplicateReviewStale";
  }
  if (message.includes("NO_KEEPER")) {
    return "duplicateNoKeeper";
  }
  return fallback;
}
