/** Shared normalized motion for the live gallery and its settings preview. */
export function wanderColumnOffset(
  travel: number,
  progress: number,
  columnIndex: number
): number {
  const normalized = Math.max(0, Math.min(1, progress));
  return (
    -Math.max(0, travel) * (columnIndex % 2 === 0 ? normalized : 1 - normalized)
  );
}

export function wanderProgressForOffset(
  travel: number,
  offset: number,
  columnIndex: number
): number {
  if (travel <= 0) {
    return 0;
  }
  const normalized = offset / travel;
  return Math.max(
    0,
    Math.min(1, columnIndex % 2 === 0 ? normalized : 1 - normalized)
  );
}
