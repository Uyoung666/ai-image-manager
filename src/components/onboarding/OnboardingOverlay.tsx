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
import { ipc } from "@/ipc/manager";
import { GpuSettingsCard } from "@/components/gpu-settings-card";
import LangToggle from "@/components/lang-toggle";
import { useOnboarding } from "./OnboardingProvider";
import { StepIndicator } from "./StepIndicator";

// ── Component ───────────────────────────────────────────────────────

export function OnboardingOverlay() {
  const { t } = useTranslation();
  const { needsOnboarding, setNeedsOnboarding } = useOnboarding();

  // ── Step state ──────────────────────────────────────────────────

  const [currentStep, setCurrentStep] = useState(1);
  const [dataPath, setDataPath] = useState<string>("");
  const [isMigrating, setIsMigrating] = useState(false);
  const [migrationError, setMigrationError] = useState<string | null>(null);

  // ── Init: check onboarding status + get data path ───────────────

  useEffect(() => {
    let cancelled = false;

    async function init() {
      // Check if user previously completed onboarding
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

      if (cancelled) return;

      if (onboardingCompleted) {
        setNeedsOnboarding(false);
        return;
      }

      // First launch — show onboarding
      setNeedsOnboarding(true);

      // Get current data path
      try {
        const pathInfo = await ipc.client.settings.getDataPathInfo({});
        if (!cancelled && pathInfo?.path) {
          setDataPath(pathInfo.path);
        }
      } catch {
        // settings IPC not ready
      }
    }

    init();
    return () => {
      cancelled = true;
    };
  }, [setNeedsOnboarding]);

  // ── Handlers ──────────────────────────────────────────────────

  const handleChangeDirectory = useCallback(async () => {
    try {
      const result = await ipc.client.shell.openFolderDialog({});
      const newPath = (result as any).path;
      if (!newPath) return;

      setIsMigrating(true);
      setMigrationError(null);

      await ipc.client.settings.setDataPath({ newPath });
      setDataPath(newPath);
    } catch (err) {
      setMigrationError(
        t("onboardingErrorMigration", {
          error: (err as Error).message ?? String(err),
        }),
      );
    } finally {
      setIsMigrating(false);
    }
  }, [t]);

  const handleFinish = useCallback(async () => {
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
    setNeedsOnboarding(false);
    window.postMessage({ channel: "onboarding-done" }, "*");
  }, [setNeedsOnboarding]);

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
    [t],
  );

  // ── Don't render if onboarding is not needed ──────────────────

  if (!needsOnboarding) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/95 backdrop-blur-sm">
      <div className="mx-4 w-full max-w-lg rounded-xl border border-border bg-card p-8 shadow-2xl">
        {/* Step indicator */}
        <StepIndicator currentStep={currentStep} steps={steps} />

        <div className="mt-8">
          {/* ── Step 1: Data directory ─────────────────────────── */}
          {currentStep === 1 && (
            <div className="space-y-6">
              <div className="space-y-2">
                <h2 className="text-lg font-semibold text-foreground">
                  {t("onboardingStep1Title")}
                </h2>
                <p className="text-sm text-muted-foreground">
                  {t("onboardingStep1Desc")}
                </p>
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between rounded-lg border border-border/60 bg-muted/30 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-[11px] text-muted-foreground">
                      {t("onboardingStep1CurrentPath")}
                    </p>
                    <p className="mt-0.5 truncate font-mono text-xs text-foreground">
                      {dataPath || t("defaultPath")}
                    </p>
                  </div>
                  <button
                    className="ml-3 inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
                    disabled={isMigrating}
                    onClick={handleChangeDirectory}
                    type="button"
                  >
                    <FolderOpen className="h-3.5 w-3.5" />
                    {t("onboardingStep1Change")}
                  </button>
                </div>

                {isMigrating && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {t("onboardingStep1Migrating")}
                  </div>
                )}

                {migrationError && (
                  <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>{migrationError}</span>
                  </div>
                )}
              </div>

              <div className="flex justify-end">
                <button
                  className="inline-flex items-center gap-2 rounded-md bg-primary px-5 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50"
                  disabled={isMigrating}
                  onClick={() => setCurrentStep(2)}
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
            <div className="space-y-6">
              <div className="space-y-2">
                <h2 className="text-lg font-semibold text-foreground">
                  {t("gpuAcceleration")}
                </h2>
                <p className="text-sm text-muted-foreground">
                  {t("gpuEnableAcceleration")}
                </p>
              </div>

              <GpuSettingsCard />

              <div className="flex items-center justify-between">
                <button
                  className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-4 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  onClick={() => setCurrentStep(1)}
                  type="button"
                >
                  <ArrowLeft className="h-4 w-4" />
                  {t("onboardingStep1Title")}
                </button>
                <button
                  className="inline-flex items-center gap-2 rounded-md bg-primary px-5 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                  onClick={() => setCurrentStep(3)}
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
            <div className="space-y-6 text-center">
              <div className="space-y-4">
                <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-green-500/10">
                  <CheckCircle className="h-8 w-8 text-green-500" />
                </div>

                <div className="space-y-2">
                  <h2 className="text-xl font-semibold text-foreground">
                    {t("onboardingStep3Title")}
                  </h2>
                  <p className="text-sm text-muted-foreground">
                    {t("onboardingStep3Desc")}
                  </p>
                </div>
              </div>

              <div className="flex items-center justify-between">
                <button
                  className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-4 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  onClick={() => setCurrentStep(2)}
                  type="button"
                >
                  <ArrowLeft className="h-4 w-4" />
                  {t("gpuAcceleration")}
                </button>
                <button
                  className="inline-flex items-center gap-2 rounded-md bg-primary px-6 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
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
