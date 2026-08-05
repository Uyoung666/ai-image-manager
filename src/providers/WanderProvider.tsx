/** biome-ignore-all lint/style/useFilenamingConvention: provider names follow the repository's existing React convention. */
import { useLocation } from "@tanstack/react-router";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  getWanderSession,
  getWanderSettings,
  saveWanderSessionToAlbum,
  setWanderSettings,
} from "@/actions/wander";
import { WanderOverlay } from "@/components/wander/WanderOverlay";
import { IPC_CHANNELS, type WanderLifecycleState } from "@/constants";
import { useGlobalAiStatus } from "@/hooks/use-global-ai-status";
import {
  DEFAULT_WANDER_SETTINGS,
  type WanderContentMode,
  type WanderMode,
  type WanderSession,
  type WanderSettings,
} from "@/types/wander";

const ROUND_SIZE = 8;
const MIN_ROUND_SIZE = 2;
const MAX_ROUND_FAILURES = 3;
const RETRY_DELAY_MS = 1000;
const POINTER_THROTTLE_MS = 1000;

interface WanderContextValue {
  active: boolean;
  loading: boolean;
  preferences: WanderSettings;
  start: (mode?: WanderMode) => Promise<void>;
  updatePreference: <K extends keyof WanderSettings>(
    key: K,
    value: WanderSettings[K]
  ) => Promise<void>;
}

const WanderContext = createContext<WanderContextValue | null>(null);

function hasBlockingSurface() {
  return Boolean(
    document.querySelector(
      '[data-slot="dialog-content"], .lightbox-interactive, .onboarding-overlay, [data-wander-blocking="true"]'
    )
  );
}

// E2E-only overrides injected via localStorage before launch. Absent in
// production, so callers fall back to the normal settings. Must never throw.
function readOverrideMs(key: string): number {
  try {
    const parsed = Number(window.localStorage.getItem(key));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  } catch {
    return 0;
  }
}

export function WanderProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const location = useLocation();
  const isHomePage = location.pathname === "/";
  const aiStatus = useGlobalAiStatus();
  const [preferences, setPreferences] = useState<WanderSettings>(
    DEFAULT_WANDER_SETTINGS
  );
  const [session, setSession] = useState<WanderSession | null>(null);
  const [roundSeq, setRoundSeq] = useState(0);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [preparingNext, setPreparingNext] = useState(false);
  const loadingRef = useRef(false);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestRef = useRef(0);
  const preferencesRef = useRef(preferences);
  const aiRunningRef = useRef(aiStatus.isRunning);
  const sessionRef = useRef(session);
  const nextSessionRef = useRef<WanderSession | null>(null);
  const prefetchPromiseRef = useRef<Promise<WanderSession | null> | null>(null);
  const consecutiveFailuresRef = useRef(0);
  const scheduleIdleRef = useRef<(() => void) | null>(null);
  const [lifecycleEligible, setLifecycleEligible] = useState(() => {
    const state = window.electronAPI?.getWanderLifecycleState?.();
    return (
      state?.eligible ??
      (document.visibilityState === "visible" && document.hasFocus())
    );
  });
  const lifecycleEligibleRef = useRef(lifecycleEligible);
  preferencesRef.current = preferences;
  aiRunningRef.current = aiStatus.isRunning;
  sessionRef.current = session;
  lifecycleEligibleRef.current = lifecycleEligible;

  useEffect(() => {
    let cancelled = false;
    getWanderSettings()
      .then((value) => {
        if (!cancelled) {
          setPreferences(value);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const fetchRound = useCallback(
    async (
      mode: WanderMode,
      requestId: number,
      opts?: { excludeMode?: WanderContentMode }
    ): Promise<WanderSession | null> => {
      const roundSizeOverride = readOverrideMs("wander.roundSize");
      const roundSize =
        roundSizeOverride > 0 ? Math.floor(roundSizeOverride) : ROUND_SIZE;
      const result = await getWanderSession({
        allowedModes: preferencesRef.current.modes,
        excludeMode: opts?.excludeMode,
        limit: roundSize,
        mode,
      });
      if (requestId !== requestRef.current) {
        return null;
      }
      return result.photos.length >= MIN_ROUND_SIZE ? result : null;
    },
    []
  );

  const prefetchNextRound = useCallback(
    (requestId: number): Promise<WanderSession | null> => {
      const promise = fetchRound("auto", requestId, {
        excludeMode: sessionRef.current?.mode,
      })
        .then((result) => {
          if (requestId === requestRef.current) {
            nextSessionRef.current = result;
            if (result) {
              consecutiveFailuresRef.current = 0;
            }
          }
          return result;
        })
        .catch(() => {
          if (requestId === requestRef.current) {
            nextSessionRef.current = null;
          }
          return null;
        });
      prefetchPromiseRef.current = promise;
      const settle = () => {
        if (prefetchPromiseRef.current === promise) {
          prefetchPromiseRef.current = null;
        }
      };
      promise.then(settle, settle);
      return promise;
    },
    [fetchRound]
  );

  const resetWanderState = useCallback(() => {
    requestRef.current += 1;
    sessionRef.current = null;
    nextSessionRef.current = null;
    prefetchPromiseRef.current = null;
    consecutiveFailuresRef.current = 0;
    loadingRef.current = false;
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    setSession(null);
    setLoading(false);
    setPreparingNext(false);
  }, []);

  const close = useCallback(() => {
    resetWanderState();
  }, [resetWanderState]);

  const promoteNext = useCallback(
    (next: WanderSession) => {
      nextSessionRef.current = null;
      consecutiveFailuresRef.current = 0;
      sessionRef.current = next;
      setSession(next);
      setRoundSeq((value) => value + 1);
      prefetchNextRound(requestRef.current).catch(() => undefined);
      setPreparingNext(false);
    },
    [prefetchNextRound]
  );

  const waitForNextRound = useCallback(() => {
    if (!sessionRef.current) {
      return;
    }
    const requestId = requestRef.current;
    setPreparingNext(true);
    const pending = prefetchPromiseRef.current;
    (pending ?? prefetchNextRound(requestId))
      .then((result) => {
        if (!sessionRef.current) {
          return;
        }
        if (result) {
          promoteNext(result);
          return;
        }
        consecutiveFailuresRef.current += 1;
        if (consecutiveFailuresRef.current >= MAX_ROUND_FAILURES) {
          close();
          toast.error(t("wander.loadFailed"));
          return;
        }
        retryTimerRef.current = setTimeout(
          () => waitForNextRound(),
          RETRY_DELAY_MS
        );
      })
      .catch(() => undefined);
  }, [close, prefetchNextRound, promoteNext, t]);

  const handleRoundComplete = useCallback(() => {
    if (!sessionRef.current) {
      return;
    }
    const next = nextSessionRef.current;
    if (next) {
      promoteNext(next);
      return;
    }
    waitForNextRound();
  }, [promoteNext, waitForNextRound]);

  const start = useCallback(
    async (requestedMode?: WanderMode, automatic = false) => {
      if (loadingRef.current || sessionRef.current) {
        return;
      }
      const requestId = ++requestRef.current;
      loadingRef.current = true;
      setLoading(true);
      try {
        const result = await fetchRound(requestedMode ?? "auto", requestId);
        if (requestId !== requestRef.current) {
          return;
        }
        if (!result) {
          if (automatic) {
            // Silently reset the idle window so the next full idle period retries.
            scheduleIdleRef.current?.();
          } else {
            toast.info(t("wander.notEnoughPhotos"));
          }
          return;
        }
        sessionRef.current = result;
        setSession(result);
        setRoundSeq((value) => value + 1);
        consecutiveFailuresRef.current = 0;
        prefetchNextRound(requestId).catch(() => undefined);
      } catch {
        if (automatic) {
          scheduleIdleRef.current?.();
        } else {
          toast.error(t("wander.loadFailed"));
        }
      } finally {
        if (requestId === requestRef.current) {
          loadingRef.current = false;
          setLoading(false);
        }
      }
    },
    [fetchRound, prefetchNextRound, t]
  );

  useEffect(() => {
    const handleLifecycle = (event: MessageEvent) => {
      const state = event.data as Partial<WanderLifecycleState> | undefined;
      if (state?.channel !== IPC_CHANNELS.WANDER_LIFECYCLE) {
        return;
      }
      const eligible = state.eligible === true;
      lifecycleEligibleRef.current = eligible;
      setLifecycleEligible(eligible);
      if (!eligible) {
        resetWanderState();
      }
    };
    window.addEventListener("message", handleLifecycle);
    return () => window.removeEventListener("message", handleLifecycle);
  }, [resetWanderState]);

  useEffect(() => {
    const automaticEnabled =
      lifecycleEligible &&
      preferences.enabled &&
      !session &&
      !loading &&
      isHomePage;
    const idleMsOverride = readOverrideMs("wander.idleMs");
    const idleDelay =
      idleMsOverride > 0 ? idleMsOverride : preferences.idleMinutes * 60_000;
    const clearTimer = () => {
      if (idleTimerRef.current) {
        clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
    };
    const schedule = () => {
      clearTimer();
      if (!automaticEnabled) {
        return;
      }
      idleTimerRef.current = setTimeout(() => {
        if (
          !lifecycleEligibleRef.current ||
          aiRunningRef.current ||
          hasBlockingSurface()
        ) {
          schedule();
          return;
        }
        start(undefined, true).catch(() => undefined);
      }, idleDelay);
    };
    scheduleIdleRef.current = schedule;
    let lastPointerMove = 0;
    const handleActivity = (event: Event) => {
      if (event.type === "pointermove") {
        const now = performance.now();
        if (now - lastPointerMove < POINTER_THROTTLE_MS) {
          return;
        }
        lastPointerMove = now;
      }
      schedule();
    };
    const events: (keyof WindowEventMap)[] = [
      "keydown",
      "pointerdown",
      "pointermove",
      "touchstart",
      "wheel",
    ];
    for (const event of events) {
      window.addEventListener(event, handleActivity, {
        capture: true,
        passive: true,
      });
    }
    document.addEventListener("visibilitychange", schedule);
    window.addEventListener("focus", schedule);
    window.addEventListener("blur", clearTimer);
    schedule();
    return () => {
      clearTimer();
      scheduleIdleRef.current = null;
      for (const event of events) {
        window.removeEventListener(event, handleActivity, true);
      }
      document.removeEventListener("visibilitychange", schedule);
      window.removeEventListener("focus", schedule);
      window.removeEventListener("blur", clearTimer);
    };
  }, [isHomePage, lifecycleEligible, loading, preferences, session, start]);

  const updatePreference = useCallback(
    async <K extends keyof WanderSettings>(
      key: K,
      value: WanderSettings[K]
    ) => {
      const previous = preferencesRef.current;
      const next = { ...previous, [key]: value };
      preferencesRef.current = next;
      setPreferences(next);
      try {
        await setWanderSettings(next);
      } catch {
        preferencesRef.current = previous;
        setPreferences(previous);
        toast.error(t("wander.settingsSaveFailed"));
        throw new Error("Failed to save Wander setting");
      }
    },
    [t]
  );

  const save = useCallback(async () => {
    if (!session || saving) {
      return;
    }
    setSaving(true);
    try {
      const title = t(session.titleKey, session.titleParams ?? {});
      await saveWanderSessionToAlbum({
        photoIds: session.photos.map((photo) => photo.id),
        title,
      });
      toast.success(t("wander.saved", { title }));
    } catch {
      toast.error(t("wander.saveFailed"));
    } finally {
      setSaving(false);
    }
  }, [saving, session, t]);

  const value = useMemo<WanderContextValue>(
    () => ({
      active: Boolean(session),
      loading,
      preferences,
      start,
      updatePreference,
    }),
    [loading, preferences, session, start, updatePreference]
  );

  const intervalMsOverride = readOverrideMs("wander.intervalMs");
  const intervalMs =
    intervalMsOverride > 0
      ? intervalMsOverride
      : preferences.intervalSeconds * 1000;

  return (
    <WanderContext.Provider value={value}>
      {children}
      {session && (
        <WanderOverlay
          intervalMs={intervalMs}
          key={roundSeq}
          onClose={close}
          onRoundComplete={handleRoundComplete}
          onSave={save}
          preparingNext={preparingNext}
          roundNumber={roundSeq}
          saving={saving}
          session={session}
        />
      )}
    </WanderContext.Provider>
  );
}

export function useWander() {
  const value = useContext(WanderContext);
  if (!value) {
    throw new Error("useWander must be used within WanderProvider");
  }
  return value;
}
