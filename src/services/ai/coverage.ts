export type AiCoverageState = "ready" | "partial" | "unavailable" | "error";

export function deriveAiCoverageState(
  totalPhotos: number,
  indexedPhotos: number,
  hasError: boolean
): AiCoverageState {
  if (hasError) {
    return "error";
  }
  if (totalPhotos === 0 || indexedPhotos >= totalPhotos) {
    return "ready";
  }
  return indexedPhotos === 0 ? "unavailable" : "partial";
}
