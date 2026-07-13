import { useTranslation } from "react-i18next";

interface StepIndicatorProps {
  currentStep: number;
  totalSteps: number;
}

/**
 * 极简圆点式步骤指示器。
 * - 当前步骤：加宽为短线 + 品牌色填充
 * - 已完成步骤：品牌色半透明
 * - 未完成步骤：灰色低透明度
 */
export function StepIndicator({ currentStep, totalSteps }: StepIndicatorProps) {
  const { t } = useTranslation();

  return (
    <div
      aria-label={t("onboardingStepProgress", {
        current: currentStep,
        total: totalSteps,
      })}
      aria-live="polite"
      className="flex items-center justify-center gap-2"
      role="status"
    >
      {Array.from({ length: totalSteps }, (_, i) => {
        const step = i + 1;
        const isActive = step === currentStep;
        const isDone = step < currentStep;

        return (
          <div
            aria-hidden="true"
            className={`onboarding-dot ${isActive ? "active" : ""} ${isDone ? "done" : ""}`}
            key={step}
          />
        );
      })}
    </div>
  );
}
