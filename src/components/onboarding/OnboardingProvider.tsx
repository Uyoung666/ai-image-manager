import { createContext, type ReactNode, useContext, useState } from "react";

interface OnboardingContextValue {
  /** true 时表示引导覆盖层正在播放退出动画，此时应用内容应已渲染在下方 */
  exiting: boolean;
  needsOnboarding: boolean;
  setExiting: (v: boolean) => void;
  setNeedsOnboarding: (v: boolean) => void;
}

const OnboardingContext = createContext<OnboardingContextValue>({
  needsOnboarding: false,
  exiting: false,
  setNeedsOnboarding: () => {},
  setExiting: () => {},
});

export function useOnboarding() {
  return useContext(OnboardingContext);
}

export function OnboardingProvider({ children }: { children: ReactNode }) {
  const [needsOnboarding, setNeedsOnboarding] = useState(false);
  const [exiting, setExiting] = useState(false);

  return (
    <OnboardingContext.Provider
      value={{
        needsOnboarding,
        exiting,
        setNeedsOnboarding,
        setExiting,
      }}
    >
      {children}
    </OnboardingContext.Provider>
  );
}
