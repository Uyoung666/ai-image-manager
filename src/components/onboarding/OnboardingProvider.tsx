import { createContext, type ReactNode, useContext, useState } from "react";

interface OnboardingContextValue {
  needsOnboarding: boolean;
  setNeedsOnboarding: (v: boolean) => void;
}

const OnboardingContext = createContext<OnboardingContextValue>({
  needsOnboarding: false,
  setNeedsOnboarding: () => {},
});

export function useOnboarding() {
  return useContext(OnboardingContext);
}

export function OnboardingProvider({ children }: { children: ReactNode }) {
  const [needsOnboarding, setNeedsOnboarding] = useState(false);

  return (
    <OnboardingContext.Provider
      value={{
        needsOnboarding,
        setNeedsOnboarding,
      }}
    >
      {children}
    </OnboardingContext.Provider>
  );
}
