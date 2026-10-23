const cleanups = new Set<() => void>();

/** Host services register without creating database/service import cycles. */
export function registerGalleryCleanup(cleanup: () => void): void {
  cleanups.add(cleanup);
}

export function releaseGalleryResources(): void {
  for (const cleanup of cleanups) {
    cleanup();
  }
}
