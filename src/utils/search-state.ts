export interface SavedSearchRestoreState {
  drillConsumed: boolean;
  hasDrillParams: boolean;
  restored: boolean;
}

/** Saved search restoration must not run after a drill-down was handled. */
export function shouldRestoreSavedSearch({
  drillConsumed,
  hasDrillParams,
  restored,
}: SavedSearchRestoreState): boolean {
  return !(drillConsumed || hasDrillParams || restored);
}
