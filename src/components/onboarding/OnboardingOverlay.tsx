import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  CheckCircle,
  FolderOpen,
  Loader2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { GpuSettingsCard } from "@/components/gpu-settings-card";
import LangToggle from "@/components/lang-toggle";
import { ipc } from "@/ipc/manager";
import { queryClient } from "@/providers/QueryProvider";
import { useOnboarding } from "./OnboardingProvider";
import { StepIndicator } from "./StepIndicator";

// ── 步骤持久化 key ──────────────────────────────────────────────

const ONBOARDING_STEP_KEY = "onboarding_current_step";

function loadPersistedStep(): number {
  try {
    const raw = localStorage.getItem(ONBOARDING_STEP_KEY);
    if (raw !== null) {
      const n = Number(raw);
      return n >= 1 && n <= 3 ? n : 1;
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

// ── Component ───────────────────────────────────────────────────────

export function OnboardingOverlay() {
  const { t } = useTranslation();
  const { needsOnboarding, exiting, setNeedsOnboarding, setExiting } =
    useOnboarding();

  // ── Step state ──────────────────────────────────────────────────

  const [currentStep, setCurrentStep] = useState(() => loadPersistedStep());
  const [stepDirection, setStepDirection] = useState<"forward" | "backward">(
    "forward"
  );
  const [dataPath, setDataPath] = useState<string>("");
  const [isMigrating, setIsMigrating] = useState(false);
  const [migrationError, setMigrationError] = useState<string | null>(null);
  const [celebrated, setCelebrated] = useState(false);

  // 步骤切换动画 key：每次步骤变化时更新，驱动 CSS 动画重新播放
  const [stepAnimKey, setStepAnimKey] = useState(0);

  // ── 开发开关：设置 localStorage DEV_FORCE_ONBOARDING = "true" 后刷新即可强制进入引导 ─
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

      // First launch — show onboarding
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

  // ── 步骤切换包装（记录方向 + 持久化）─────────────────────────

  const goToStep = useCallback((step: number) => {
    setCurrentStep((prev) => {
      setStepDirection(step > prev ? "forward" : "backward");
      persistStep(step);
      return step;
    });
    setStepAnimKey((k) => k + 1);
  }, []);

  // ── 步骤 3 预加载首页数据 ──────────────────────────────────────

  useEffect(() => {
    if (currentStep !== 3) {
      return;
    }

    // 预加载侧边栏文件夹列表
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

    // 预加载默认照片列表第一页
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
  }, [currentStep]);

  // ── 步骤 3 庆祝动画触发 ────────────────────────────────────────

  useEffect(() => {
    if (currentStep === 3 && !celebrated) {
      // 延迟一帧确保 DOM 已挂载
      const raf = requestAnimationFrame(() => setCelebrated(true));
      return () => cancelAnimationFrame(raf);
    }
    if (currentStep !== 3 && celebrated) {
      setCelebrated(false);
    }
  }, [currentStep, celebrated]);

  // ── Handlers ──────────────────────────────────────────────────

  const handleChangeDirectory = useCallback(async () => {
    try {
      const result = await ipc.client.shell.openFolderDialog({});
      const newPath = (result as any).path;
      if (!newPath) {
        return;
      }

      setIsMigrating(true);
      setMigrationError(null);

      await ipc.client.settings.setDataPath({ newPath });
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

  const handleFinish = useCallback(async () => {
    // 先触发退出动画
    setExiting(true);

    try {
      await ipc.client.settings.setAppSetting({
        key: "onboarding.completed",
        value: "true",
      });
      // Mark GPU prompt as shown so legacy dialog doesn't appear
      await ipc.client.settings.markGpuPromptShown({});
    } catch {
      // best-effort
    }

    clearPersistedStep();
    window.postMessage({ channel: "onboarding-done" }, "*");
    // setNeedsOnboarding(false) 由 animationEnd 回调执行
  }, [setExiting]);

  const handleExitAnimationEnd = useCallback(() => {
    setNeedsOnboarding(false);
    setExiting(false);
  }, [setNeedsOnboarding, setExiting]);

  // ── Steps definition ──────────────────────────────────────────

  const steps = useMemo(
    () => [
      {
        title: t("onboardingStep1Title"),
        description: t("onboardingStep1Desc"),
      },
      {
        title: t("gpuAcceleration"),
        description: t("gpuEnableAcceleration"),
      },
      {
        title: t("onboardingStep3Title"),
        description: t("onboardingStep3Desc"),
      },
    ],
    [t]
  );

  // ── Don't render if onboarding is not needed ──────────────────

  if (!needsOnboarding) {
    return null;
  }

  const overlayAnimClass = exiting ? "animate-onboarding-exit" : "";
  const stepAnimClass =
    stepDirection === "forward"
      ? "animate-step-enter-right"
      : "animate-step-enter-left";

  return (
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center bg-background ${overlayAnimClass}`}
      onAnimationEnd={(e) => {
        if (exiting && e.currentTarget === e.target) {
          handleExitAnimationEnd();
        }
      }}
      style={{
        backgroundImage:
          "radial-gradient(ellipse at 50% 35%, color-mix(in srgb, var(--primary) 12%, transparent) 0%, transparent 65%)",
      }}
    >
      {/* 卡片 */}
      <div className="surface-elevated relative mx-4 w-full max-w-lg rounded-xl border border-border bg-card p-8 shadow-2xl">
        {/* Step indicator */}
        <StepIndicator currentStep={currentStep} steps={steps} />

        <div className="mt-8">
          {/* ── Step 1: Data directory ─────────────────────────── */}
          {currentStep === 1 && (
            <div
              className={`space-y-6 ${stepAnimClass}`}
              key={`step-1-${stepAnimKey}`}
            >
              <div className="space-y-2">
                <h2 className="font-semibold text-foreground text-lg">
                  {t("onboardingStep1Title")}
                </h2>
                <p className="text-muted-foreground text-sm">
                  {t("onboardingStep1Desc")}
                </p>
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between rounded-lg border border-border/60 bg-muted/30 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-[11px] text-muted-foreground">
                      {t("onboardingStep1CurrentPath")}
                    </p>
                    <p className="mt-0.5 truncate font-mono text-foreground text-xs">
                      {dataPath || t("defaultPath")}
                    </p>
                  </div>
                  <button
                    className="ml-3 inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 font-medium text-foreground text-xs transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
                    disabled={isMigrating}
                    onClick={handleChangeDirectory}
                    type="button"
                  >
                    <FolderOpen className="h-3.5 w-3.5" />
                    {t("onboardingStep1Change")}
                  </button>
                </div>

                {isMigrating && (
                  <div className="flex items-center gap-2 text-muted-foreground text-sm">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {t("onboardingStep1Migrating")}
                  </div>
                )}

                {migrationError && (
                  <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-destructive text-sm">
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>{migrationError}</span>
                  </div>
                )}
              </div>

              <div className="flex justify-end">
                <button
                  className="inline-flex items-center gap-2 rounded-md bg-primary px-5 py-2 font-medium text-primary-foreground text-sm transition-colors hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50"
                  disabled={isMigrating}
                  onClick={() => goToStep(2)}
                  type="button"
                >
                  {t("gpuAcceleration")}
                  <ArrowRight className="h-4 w-4" />
                </button>
              </div>
            </div>
          )}

          {/* ── Step 2: GPU Acceleration ─────────────────────────── */}
          {currentStep === 2 && (
            <div
              className={`space-y-6 ${stepAnimClass}`}
              key={`step-2-${stepAnimKey}`}
            >
              <div className="space-y-2">
                <h2 className="font-semibold text-foreground text-lg">
                  {t("gpuAcceleration")}
                </h2>
                <p className="text-muted-foreground text-sm">
                  {t("gpuEnableAcceleration")}
                </p>
              </div>

              <GpuSettingsCard />

              <div className="flex items-center justify-between">
                <button
                  className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-4 py-2 font-medium text-muted-foreground text-sm transition-colors hover:bg-accent hover:text-foreground"
                  onClick={() => goToStep(1)}
                  type="button"
                >
                  <ArrowLeft className="h-4 w-4" />
                  {t("onboardingStep1Title")}
                </button>
                <button
                  className="inline-flex items-center gap-2 rounded-md bg-primary px-5 py-2 font-medium text-primary-foreground text-sm transition-colors hover:bg-primary/90"
                  onClick={() => goToStep(3)}
                  type="button"
                >
                  {t("onboardingStep3Title")}
                  <ArrowRight className="h-4 w-4" />
                </button>
              </div>
            </div>
          )}

          {/* ── Step 3: Complete ────────────────────────────────── */}
          {currentStep === 3 && (
            <div
              className={`space-y-6 text-center ${stepAnimClass}`}
              key={`step-3-${stepAnimKey}`}
            >
              <div className="space-y-4">
                {/* 庆祝动画：脉冲环 + 弹性勾 */}
                <div className="relative mx-auto flex h-16 w-16 items-center justify-center">
                  {celebrated && (
                    <div
                      aria-hidden="true"
                      className="absolute inset-0 animate-celebrate-pulse rounded-full bg-green-500/20"
                    />
                  )}
                  <div
                    className={`relative z-10 flex h-16 w-16 items-center justify-center rounded-full bg-green-500/10 ${
                      celebrated ? "animate-celebrate-bounce" : "opacity-0"
                    }`}
                  >
                    <CheckCircle className="h-8 w-8 text-green-500" />
                  </div>
                </div>

                <div className="space-y-2">
                  <h2 className="font-semibold text-foreground text-xl">
                    {t("onboardingStep3Title")}
                  </h2>
                  <p className="text-muted-foreground text-sm">
                    {t("onboardingStep3Desc")}
                  </p>
                </div>
              </div>

              <div className="flex items-center justify-between">
                <button
                  className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-4 py-2 font-medium text-muted-foreground text-sm transition-colors hover:bg-accent hover:text-foreground"
                  onClick={() => goToStep(2)}
                  type="button"
                >
                  <ArrowLeft className="h-4 w-4" />
                  {t("gpuAcceleration")}
                </button>
                <button
                  className="inline-flex items-center gap-2 rounded-md bg-primary px-6 py-2.5 font-medium text-primary-foreground text-sm transition-colors hover:bg-primary/90"
                  disabled={exiting}
                  onClick={handleFinish}
                  type="button"
                >
                  {t("onboardingStep3Start")}
                  <ArrowRight className="h-4 w-4" />
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Language switch — subtle, at card bottom */}
        <div className="mt-8 flex items-center justify-center border-border border-t pt-4">
          <LangToggle />
        </div>
      </div>
    </div>
  );
}
