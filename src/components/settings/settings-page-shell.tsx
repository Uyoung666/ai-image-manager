import type { ReactNode, Ref } from "react";
import { cn } from "@/utils/tailwind";

interface SettingsPageShellProps {
  children: ReactNode;
  description?: ReactNode;
  maxWidth?: "default" | "wide";
  scrollRef?: Ref<HTMLDivElement>;
  title: ReactNode;
}

interface SettingsSectionProps {
  children: ReactNode;
  className?: string;
  description?: ReactNode;
  title?: ReactNode;
}

export function SettingsPageShell({
  children,
  description,
  maxWidth = "default",
  scrollRef,
  title,
}: SettingsPageShellProps) {
  return (
    <div
      className="h-full min-w-0 overflow-y-auto overflow-x-hidden overscroll-contain p-3 sm:p-6 min-[480px]:p-4"
      ref={scrollRef}
    >
      <section
        className={cn(
          "mx-auto w-full min-w-0 space-y-4",
          maxWidth === "wide" ? "max-w-[1040px]" : "max-w-[820px]"
        )}
      >
        <header>
          <h2 className="font-semibold text-[14px] text-foreground">{title}</h2>
          {description && (
            <p className="mt-1 text-[12px] text-muted-foreground [overflow-wrap:anywhere]">
              {description}
            </p>
          )}
        </header>
        {children}
      </section>
    </div>
  );
}

export function SettingsSection({
  children,
  className,
  description,
  title,
}: SettingsSectionProps) {
  return (
    <section className={cn("min-w-0 space-y-3", className)}>
      {(title || description) && (
        <div>
          {title && (
            <h3 className="font-medium text-[13px] text-foreground">{title}</h3>
          )}
          {description && (
            <p className="mt-0.5 text-[11px] text-muted-foreground [overflow-wrap:anywhere]">
              {description}
            </p>
          )}
        </div>
      )}
      <div className="min-w-0 rounded-[8px] border border-border bg-secondary p-3 min-[480px]:p-4">
        {children}
      </div>
    </section>
  );
}
