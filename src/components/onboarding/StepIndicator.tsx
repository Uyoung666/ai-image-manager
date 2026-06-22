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
  return (
    <div
      aria-label={`Step ${currentStep} of ${totalSteps}`}
      className="flex items-center justify-center gap-2"
    >
      {Array.from({ length: totalSteps }, (_, i) => {
        const step = i + 1;
        const isActive = step === currentStep;
        const isDone = step < currentStep;

        return (
          <div
            className={`onboarding-dot ${isActive ? "active" : ""} ${isDone ? "done" : ""}`}
            key={step}
          />
        );
      })}
    </div>
  );
}
