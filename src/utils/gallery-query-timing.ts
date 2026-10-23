let recentQueryMs = 100;
export function observeGalleryQuery(duration: number): void {
  recentQueryMs =
    recentQueryMs * 0.8 + Math.min(2000, Math.max(0, duration)) * 0.2;
}
export function galleryPagePreloadMargin(
  velocity: number,
  viewport: number
): number {
  return Math.max(
    2000,
    Math.min(
      Math.max(2000, viewport * 6),
      Math.abs(velocity) * (recentQueryMs + 150)
    )
  );
}
