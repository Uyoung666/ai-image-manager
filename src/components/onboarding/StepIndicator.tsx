import { Check } from "lucide-react";

interface StepIndicatorProps {
  currentStep: number;
  steps: { title: string; description: string }[];
}

export function StepIndicator({ currentStep, steps }: StepIndicatorProps) {
  return (
    <div className="flex items-start justify-center gap-0">
      {steps.map((step, i) => {
        const stepNumber = i + 1;
        const isCompleted = stepNumber < currentStep;
        const isCurrent = stepNumber === currentStep;
        const isLast = i === steps.length - 1;

        return (
          <div className="flex items-start" key={step.title}>
            {/* Step circle + label */}
            <div className="flex flex-col items-center gap-2">
              {/* Circle */}
              <div
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full font-semibold text-sm transition-colors duration-300 ${
                  isCompleted
                    ? "bg-primary text-primary-foreground"
                    : isCurrent
                      ? "bg-primary text-primary-foreground ring-4 ring-primary/20"
                      : "bg-muted text-muted-foreground"
                }`}
              >
                {isCompleted ? (
                  <Check className="h-4 w-4" />
                ) : (
                  <span>{stepNumber}</span>
                )}
              </div>

              {/* Label */}
              <div className="text-center">
                <p
                  className={`font-medium text-sm ${
                    isCurrent
                      ? "text-foreground"
                      : isCompleted
                        ? "text-foreground/80"
                        : "text-muted-foreground"
                  }`}
                >
                  {step.title}
                </p>
                <p className="mt-0.5 max-w-[140px] text-muted-foreground text-xs">
                  {step.description}
                </p>
              </div>
            </div>

            {/* Connector line */}
            {!isLast && (
              <div className="mt-4 h-[2px] w-12 sm:w-20">
                <div className="h-full w-full rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary transition-all duration-500 ease-out"
                    style={{
                      width: isCompleted ? "100%" : "0%",
                    }}
                  />
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
