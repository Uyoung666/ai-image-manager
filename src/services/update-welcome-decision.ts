export interface UpdateWelcomeDecisionInput {
  currentVersion: string;
  hasChangelog: boolean;
  isPackaged: boolean;
  lastLaunchedVersion?: string;
  skip: boolean;
}

export interface UpdateWelcomeDecision {
  nextLaunchedVersion: string;
  version: string | null;
}

export function decideUpdateWelcomeVersion(
  input: UpdateWelcomeDecisionInput
): UpdateWelcomeDecision {
  const shouldShow =
    input.isPackaged &&
    !input.skip &&
    Boolean(input.lastLaunchedVersion) &&
    input.lastLaunchedVersion !== input.currentVersion &&
    input.hasChangelog;

  return {
    nextLaunchedVersion: input.currentVersion,
    version: shouldShow ? input.currentVersion : null,
  };
}
