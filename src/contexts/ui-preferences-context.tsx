import {
  createContext,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useState,
} from "react";
import {
  cacheReduceMotion,
  getReduceMotionPreference,
  readCachedReduceMotion,
  setReduceMotionPreference,
} from "@/actions/ui-preferences";

export interface UiPreferencesContextValue {
  reduceMotion: boolean;
  setReduceMotion: (value: boolean) => Promise<void>;
}

const defaultValue: UiPreferencesContextValue = {
  reduceMotion: false,
  setReduceMotion: async () => undefined,
};

export const UiPreferencesContext =
  createContext<UiPreferencesContextValue>(defaultValue);

function syncReduceMotionAttribute(value: boolean) {
  if (typeof document !== "undefined") {
    document.documentElement.dataset.reducedMotion = String(value);
  }
}

export function UiPreferencesProvider({ children }: { children: ReactNode }) {
  const [reduceMotion, setReduceMotionState] = useState(readCachedReduceMotion);

  useLayoutEffect(() => {
    syncReduceMotionAttribute(reduceMotion);
  }, [reduceMotion]);

  useEffect(() => {
    let active = true;
    getReduceMotionPreference()
      .then((value) => {
        if (active) {
          setReduceMotionState(value);
        }
      })
      .catch(() => {
        // Keep the cached value when the renderer starts before IPC is ready.
      });
    return () => {
      active = false;
    };
  }, []);

  const setReduceMotion = useCallback(
    async (value: boolean) => {
      const previous = reduceMotion;
      setReduceMotionState(value);
      syncReduceMotionAttribute(value);
      cacheReduceMotion(value);
      try {
        await setReduceMotionPreference(value);
      } catch (error) {
        setReduceMotionState(previous);
        syncReduceMotionAttribute(previous);
        cacheReduceMotion(previous);
        throw error;
      }
    },
    [reduceMotion]
  );

  return (
    <UiPreferencesContext.Provider value={{ reduceMotion, setReduceMotion }}>
      {children}
    </UiPreferencesContext.Provider>
  );
}
