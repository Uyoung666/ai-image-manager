export type CullPhotoStatus = "pending" | "kept" | "rejected";

/** Returns the exact reviewed-count delta for a status transition. */
export function getCullProgressDelta(
  previousStatus: string,
  nextStatus: string
): number {
  if (previousStatus === "pending" && nextStatus !== "pending") {
    return 1;
  }
  if (previousStatus !== "pending" && nextStatus === "pending") {
    return -1;
  }
  return 0;
}
