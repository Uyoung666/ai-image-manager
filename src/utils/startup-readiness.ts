export const STARTUP_HOME_READY_EVENT = "app:startup-home-ready";
export const STARTUP_ONBOARDING_STATE_EVENT = "app:startup-onboarding-state";

export interface StartupOnboardingStateDetail {
  needsOnboarding: boolean;
}

export function notifyStartupHomeReady(healthy = true): void {
  window.dispatchEvent(
    new CustomEvent(STARTUP_HOME_READY_EVENT, { detail: { healthy } })
  );
}

export function notifyStartupOnboardingState(needsOnboarding: boolean): void {
  window.dispatchEvent(
    new CustomEvent<StartupOnboardingStateDetail>(
      STARTUP_ONBOARDING_STATE_EVENT,
      { detail: { needsOnboarding } }
    )
  );
}
