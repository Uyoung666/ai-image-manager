import {
  AlertCircle,
  ArrowRight,
  Cpu,
  FolderHeart,
  FolderOpen,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { GpuSettingsCard } from "@/components/gpu-settings-card";
import LangToggle from "@/components/lang-toggle";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { ipc } from "@/ipc/manager";
import { queryClient } from "@/providers/QueryProvider";
import appIcon from "../../../assets/icon.png";
import { useOnboarding } from "./OnboardingProvider";
import { StepIndicator } from "./StepIndicator";

// ── 步骤持久化 key ──────────────────────────────────────────────

const ONBOARDING_STEP_KEY = "onboarding_current_step";
const TOTAL_STEPS = 3;

function loadPersistedStep(): number {
  try {
    const raw = localStorage.getItem(ONBOARDING_STEP_KEY);
    if (raw !== null) {
      const n = Number(raw);
      return n >= 1 && n <= TOTAL_STEPS ? n : 1;
    }
  } catch {
    /* ignore */
  }
  return 1;
}

function persistStep(step: number) {
  try {
    localStorage.setItem(ONBOARDING_STEP_KEY, String(step));
  } catch {
    /* ignore */
  }
}

function clearPersistedStep() {
  try {
    localStorage.removeItem(ONBOARDING_STEP_KEY);
  } catch {
    /* ignore */
  }
}

// ── Hero icon components ──────────────────────────────────────────

function Step1Hero() {
  return (
    <div className="flex items-center justify-center">
      <div className="animate-hero-float rounded-2xl bg-primary/10 p-5">
        <FolderHeart className="h-16 w-16 text-primary" strokeWidth={1.5} />
      </div>
    </div>
  );
}

function Step2Hero({ gpuDetected }: { gpuDetected: boolean }) {
  return (
    <div className="flex items-center justify-center">
      <div
        className={`animate-hero-float rounded-2xl p-5 transition-colors duration-500 ${
          gpuDetected ? "bg-primary/10" : "bg-muted/50"
        }`}
      >
        {gpuDetected ? (
          <Zap className="h-16 w-16 text-primary" strokeWidth={1.5} />
        ) : (
          <Cpu
            className="h-16 w-16 text-muted-foreground/50"
            strokeWidth={1.5}
          />
        )}
      </div>
    </div>
  );
}

function Step3Hero() {
  return (
    <div className="flex items-center justify-center">
      <div className="animate-hero-float rounded-2xl bg-primary/10 p-5">
        <img
          alt="App logo"
          className="h-16 w-16 select-none"
          draggable={false}
          height={64}
          src={appIcon}
          width={64}
        />
      </div>
    </div>
  );
}

// ── Component ───────────────────────────────────────────────────────

export function OnboardingOverlay() {
  const { t } = useTranslation();
  const {
    needsOnboarding,
    exiting,
    setNeedsOnboarding,
    setExiting,
    setPreRenderContent,
  } = useOnboarding();

  // ── Step state ──────────────────────────────────────────────────

  const [currentStep, setCurrentStep] = useState(() => loadPersistedStep());
  const [stepAnimKey, setStepAnimKey] = useState(0);
  const [dataPath, setDataPath] = useState<string>("");
  const [isMigrating, setIsMigrating] = useState(false);
  const [migrationError, setMigrationError] = useState<string | null>(null);
  const [gpuDetected, setGpuDetected] = useState(false);
  const [gpuEnabled, setGpuEnabled] = useState(false);
  const [gpuSettingsReady, setGpuSettingsReady] = useState(false);
  const [isConfiguringGpu, setIsConfiguringGpu] = useState(false);
  const [isSavingGpu, setIsSavingGpu] = useState(false);
  const [gpuSaveError, setGpuSaveError] = useState<string | null>(null);

  // ── 开发开关 ────────────────────────────────────────────────────

  const devForce =
    typeof localStorage !== "undefined" &&
    localStorage.getItem("DEV_FORCE_ONBOARDING") === "true";

  // ── Init: check onboarding status + get data path ───────────────

  useEffect(() => {
    let cancelled = false;

    async function initDevForce() {
      if (cancelled) {
        return;
      }
      setNeedsOnboarding(true);
      try {
        const pathInfo = await ipc.client.settings.getDataPathInfo({});
        if (!cancelled && pathInfo?.path) {
          setDataPath(pathInfo.path);
        }
      } catch {
        /* ignore */
      }
    }

    async function initNormal() {
      if (window.electronAPI?.isE2E) {
        setNeedsOnboarding(false);
        clearPersistedStep();
        return;
      }

      let onboardingCompleted = false;
      try {
        const result = await ipc.client.settings.getAppSetting({
          key: "onboarding.completed",
        });
        if (!cancelled && result?.value === "true") {
          onboardingCompleted = true;
        }
      } catch {
        // settings IPC not ready
      }

      if (cancelled) {
        return;
      }

      if (onboardingCompleted) {
        setNeedsOnboarding(false);
        clearPersistedStep();
        return;
      }

      setNeedsOnboarding(true);

      try {
        const pathInfo = await ipc.client.settings.getDataPathInfo({});
        if (!cancelled && pathInfo?.path) {
          setDataPath(pathInfo.path);
        }
      } catch {
        // settings IPC not ready
      }
    }

    if (devForce) {
      initDevForce();
    } else {
      initNormal();
    }

    return () => {
      cancelled = true;
    };
  }, [setNeedsOnboarding, devForce]);

  // ── Step 2: detect GPU status on mount ──────────────────────────

  useEffect(() => {
    if (currentStep !== 2) {
      return;
    }
    ipc.client.settings
      .getGpuSettings({})
      .then((r) => {
        if (r?.detected?.dmlAvailable) {
          setGpuDetected(true);
        }
      })
      .catch(() => {
        /* ignore */
      });
  }, [currentStep]);

  // ── 步骤切换 ────────────────────────────────────────────────────

  const goToStep = useCallback((step: number) => {
    setCurrentStep(step);
    persistStep(step);
    setStepAnimKey((k) => k + 1);
  }, []);

  // ── 步骤 3：预渲染主界面内容 + 预加载数据 ────────────────────

  useEffect(() => {
    if (currentStep !== 3) {
      return;
    }

    setPreRenderContent(true);

    queryClient.prefetchQuery({
      queryKey: ["folders"],
      queryFn: async () => {
        try {
          return await ipc.client.photos.getFolders({});
        } catch {
          return [];
        }
      },
      staleTime: 30_000,
    });

    queryClient.prefetchInfiniteQuery({
      queryKey: [
        "photos",
        {
          folderId: null,
          tagId: null,
          tagIds: null,
          tagMode: "or",
          favoriteOnly: false,
          sort: "date",
          order: "desc",
        },
      ],
      queryFn: async ({ pageParam = 0 }) => {
        try {
          return await ipc.client.photos.listPhotos({
            offset: pageParam as number,
            limit: 100,
            sort: "date",
            order: "desc",
          });
        } catch {
          return { photos: [], total: 0, offset: 0, limit: 100 };
        }
      },
      initialPageParam: 0,
      staleTime: 30_000,
    });
  }, [currentStep, setPreRenderContent]);

  // ── Handlers ──────────────────────────────────────────────────

  const handleChangeDirectory = useCallback(async () => {
    try {
      const result = await ipc.client.shell.openFolderDialog({});
      const newPath = (result as { path?: string }).path;
      if (!newPath) {
        return;
      }

      setIsMigrating(true);
      setMigrationError(null);

      const migration = (await ipc.client.settings.setDataPath({
        newPath,
      })) as { error?: string; ok: boolean };
      if (!migration.ok) {
        throw new Error(migration.error || t("dataPathSetFailed"));
      }
      setDataPath(newPath);
    } catch (err) {
      setMigrationError(
        t("onboardingErrorMigration", {
          error: (err as Error).message ?? String(err),
        })
      );
    } finally {
      setIsMigrating(false);
    }
  }, [t]);

  const handleGpuSettingsLoaded = useCallback(() => {
    setGpuSettingsReady(true);
  }, []);

  const handleGpuContinue = useCallback(async () => {
    setIsSavingGpu(true);
    setGpuSaveError(null);
    try {
      await ipc.client.settings.setGpuSettings({ enabled: gpuEnabled });
      goToStep(3);
    } catch (err) {
      setGpuSaveError(
        t("onboardingErrorGpuSave", {
          error: (err as Error).message ?? String(err),
        })
      );
    } finally {
      setIsSavingGpu(false);
    }
  }, [goToStep, gpuEnabled, t]);

  const handleFinish = useCallback(async () => {
    setExiting(true);

    try {
      await ipc.client.settings.setAppSetting({
        key: "onboarding.completed",
        value: "true",
      });
      await ipc.client.settings.markGpuPromptShown({});
    } catch {
      // best-effort
    }

    clearPersistedStep();
    window.postMessage({ channel: "onboarding-done" }, "*");
  }, [setExiting]);

  const handleExitAnimationEnd = useCallback(() => {
    setNeedsOnboarding(false);
    setExiting(false);
    setPreRenderContent(false);
  }, [setNeedsOnboarding, setExiting, setPreRenderContent]);

  // ── Don't render if onboarding is not needed ──────────────────

  if (!needsOnboarding) {
    return null;
  }

  const overlayAnimClass = exiting ? "animate-onboarding-exit" : "";

  return (
    <div
      className={`onboarding-overlay fixed inset-0 z-[100] flex flex-col items-center overflow-y-auto bg-background py-24 ${overlayAnimClass}`}
      onAnimationEnd={(e) => {
        if (exiting && e.currentTarget === e.target) {
          handleExitAnimationEnd();
        }
      }}
      style={{
        backgroundImage:
          "radial-gradient(ellipse at 50% 40%, color-mix(in srgb, var(--primary) 8%, transparent) 0%, transparent 60%)",
      }}
    >
      {/* Step indicator — top, subtle */}
      <div className="absolute top-8">
        <StepIndicator currentStep={currentStep} totalSteps={TOTAL_STEPS} />
      </div>

      {/* Content area — centered, max-width for readability */}
      <div className="mx-auto w-full max-w-md px-6">
        <div
          className="flex flex-col items-center gap-6 text-center"
          key={`step-${currentStep}-${stepAnimKey}`}
        >
          {/* ── Step 1: Data directory ─────────────────────────── */}
          {currentStep === 1 && (
            <div className="flex animate-step-enter flex-col items-center gap-6">
              <Step1Hero />

              <div className="space-y-2">
                <h2 className="font-semibold text-2xl text-foreground tracking-tight">
                  {t("onboardingStep1Title")}
                </h2>
                <p className="text-muted-foreground text-sm leading-relaxed">
                  {t("onboardingStep1Desc")}
                </p>
              </div>

              <div className="w-full space-y-3">
                <div className="flex items-center justify-between rounded-xl border border-border/60 bg-muted/20 px-5 py-4">
                  <div className="min-w-0 flex-1">
                    <p className="text-[11px] text-muted-foreground/70">
                      {t("onboardingStep1CurrentPath")}
                    </p>
                    <p className="mt-1 truncate font-mono text-foreground/80 text-xs">
                      {dataPath || t("defaultPath")}
                    </p>
                  </div>
                  <button
                    className="ml-4 inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-1.5 font-medium text-foreground text-xs transition-all hover:border-foreground/20 hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
                    disabled={isMigrating}
                    onClick={handleChangeDirectory}
                    type="button"
                  >
                    <FolderOpen className="h-3.5 w-3.5" />
                    {t("onboardingStep1Change")}
                  </button>
                </div>

                {isMigrating && (
                  <div className="flex items-center justify-center gap-2 text-muted-foreground text-sm">
                    <LoadingSpinner size="sm" />
                    {t("onboardingStep1Migrating")}
                  </div>
                )}

                {migrationError && (
                  <div
                    aria-live="polite"
                    className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-destructive text-sm"
                  >
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>{migrationError}</span>
                  </div>
                )}
              </div>

              <button
                className="inline-flex items-center gap-2 rounded-lg bg-primary px-6 py-2.5 font-medium text-primary-foreground text-sm transition-all hover:bg-primary/90 hover:shadow-lg hover:shadow-primary/20 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50"
                disabled={isMigrating}
                onClick={() => goToStep(2)}
                type="button"
              >
                {t("onboardingContinue")}
                <ArrowRight className="h-4 w-4" />
              </button>
            </div>
          )}

          {/* ── Step 2: GPU Acceleration ─────────────────────────── */}
          {currentStep === 2 && (
            <div className="flex animate-step-enter flex-col items-center gap-6">
              <Step2Hero gpuDetected={gpuDetected} />

              <div className="space-y-2">
                <h2 className="font-semibold text-2xl text-foreground tracking-tight">
                  {t("onboardingStep2Title")}
                </h2>
                <p className="text-muted-foreground text-sm leading-relaxed">
                  {t("onboardingStep2Desc")}
                </p>
              </div>

              {/* GPU card — title hidden, onboarding has its own */}
              <div className="w-full [&_h2]:hidden">
                <GpuSettingsCard
                  hideSaveButton
                  hideTitle
                  onBusyChange={setIsConfiguringGpu}
                  onEnabledChange={setGpuEnabled}
                  onLoaded={handleGpuSettingsLoaded}
                />
              </div>

              {gpuSaveError && (
                <div
                  aria-live="polite"
                  className="flex w-full items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-destructive text-sm"
                >
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{gpuSaveError}</span>
                </div>
              )}

              <div className="flex w-full items-center justify-between gap-3">
                <button
                  className="inline-flex items-center gap-1.5 rounded-lg px-4 py-2 font-medium text-muted-foreground text-sm transition-colors hover:bg-accent hover:text-foreground"
                  onClick={() => goToStep(1)}
                  type="button"
                >
                  {t("onboardingBack")}
                </button>
                <button
                  aria-busy={isSavingGpu}
                  className="inline-flex items-center gap-2 rounded-lg bg-primary px-6 py-2.5 font-medium text-primary-foreground text-sm transition-all hover:bg-primary/90 hover:shadow-lg hover:shadow-primary/20 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50"
                  disabled={
                    !gpuSettingsReady || isConfiguringGpu || isSavingGpu
                  }
                  onClick={handleGpuContinue}
                  type="button"
                >
                  {isSavingGpu ? (
                    <>
                      <LoadingSpinner size="sm" />
                      {t("saving")}
                    </>
                  ) : (
                    <>
                      {t("onboardingSaveContinue")}
                      <ArrowRight className="h-4 w-4" />
                    </>
                  )}
                </button>
              </div>
            </div>
          )}

          {/* ── Step 3: Complete ────────────────────────────────── */}
          {currentStep === 3 && (
            <div className="flex animate-step-enter flex-col items-center gap-8">
              <Step3Hero />

              <div className="space-y-3">
                <h2 className="font-semibold text-2xl text-foreground tracking-tight">
                  {t("onboardingStep3Title")}
                </h2>
                <p className="text-muted-foreground text-sm leading-relaxed">
                  {t("onboardingStep3Desc")}
                </p>
              </div>

              <button
                className="inline-flex animate-btn-glow items-center gap-2 rounded-lg bg-primary px-10 py-3 font-medium text-base text-primary-foreground transition-all hover:bg-primary/90 hover:shadow-primary/25 hover:shadow-xl active:scale-[0.97] disabled:pointer-events-none disabled:opacity-70"
                disabled={exiting}
                onClick={handleFinish}
                type="button"
              >
                {exiting ? (
                  <>
                    <LoadingSpinner size="md" />
                    {t("onboardingStep3Starting")}
                  </>
                ) : (
                  t("onboardingStep3Start")
                )}
              </button>

              <button
                className="font-medium text-muted-foreground text-xs transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
                disabled={exiting}
                onClick={() => goToStep(2)}
                type="button"
              >
                {t("onboardingBack")}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Language toggle — bottom right, subtle */}
      <div className="fixed right-4 bottom-4 opacity-70 transition-opacity duration-300 focus-within:opacity-100 hover:opacity-100 sm:right-6 sm:bottom-6">
        <LangToggle />
      </div>
    </div>
  );
}
