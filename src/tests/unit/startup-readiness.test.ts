import { describe, expect, it, vi } from "vitest";
import {
  notifyStartupHomeReady,
  notifyStartupOnboardingState,
  STARTUP_HOME_READY_EVENT,
  STARTUP_ONBOARDING_STATE_EVENT,
} from "@/utils/startup-readiness";

describe("startup readiness events", () => {
  it("notifies the startup coordinator when the home first frame is ready", () => {
    const listener = vi.fn();
    const handler = (event: Event) => {
      expect(event.type).toBe(STARTUP_HOME_READY_EVENT);
      listener();
    };
    window.addEventListener(STARTUP_HOME_READY_EVENT, handler);

    notifyStartupHomeReady();

    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener(STARTUP_HOME_READY_EVENT, handler);
  });

  it("includes whether onboarding is required", () => {
    const listener = vi.fn();
    const handler = (event: Event) => {
      listener();
      expect(
        (event as CustomEvent<{ needsOnboarding: boolean }>).detail
      ).toEqual({ needsOnboarding: true });
    };
    window.addEventListener(STARTUP_ONBOARDING_STATE_EVENT, handler);

    notifyStartupOnboardingState(true);

    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener(STARTUP_ONBOARDING_STATE_EVENT, handler);
  });
});
