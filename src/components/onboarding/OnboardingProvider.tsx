import { createContext, type ReactNode, useContext, useState } from "react";

interface OnboardingContextValue {
  /** true 时引导覆盖层正在淡出，应用内容已在下方渲染 */
  exiting: boolean;
  needsOnboarding: boolean;
  /** 提前渲染应用内容（Step 3 显示时置 true，让内容在遮罩后完成挂载） */
  preRenderContent: boolean;
  setExiting: (v: boolean) => void;
  setNeedsOnboarding: (v: boolean) => void;
  setPreRenderContent: (v: boolean) => void;
}

const OnboardingContext = createContext<OnboardingContextValue>({
  needsOnboarding: false,
  exiting: false,
  preRenderContent: false,
  setNeedsOnboarding: () => {},
  setExiting: () => {},
  setPreRenderContent: () => {},
});

export function useOnboarding() {
  return useContext(OnboardingContext);
}

export function OnboardingProvider({ children }: { children: ReactNode }) {
  const [needsOnboarding, setNeedsOnboarding] = useState(false);
  const [exiting, setExiting] = useState(false);
  const [preRenderContent, setPreRenderContent] = useState(false);

  return (
    <OnboardingContext.Provider
      value={{
        needsOnboarding,
        exiting,
        preRenderContent,
        setNeedsOnboarding,
        setExiting,
        setPreRenderContent,
      }}
    >
      {children}
    </OnboardingContext.Provider>
  );
}
