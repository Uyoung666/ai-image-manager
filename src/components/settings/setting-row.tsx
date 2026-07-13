import type { ReactNode } from "react";
import { cn } from "@/utils/tailwind";

interface SettingRowProps {
  action?: ReactNode;
  children?: ReactNode;
  className?: string;
  description?: ReactNode;
  title: ReactNode;
  tone?: "default" | "warning" | "destructive";
}

export function SettingRow({
  action,
  children,
  className,
  description,
  title,
  tone = "default",
}: SettingRowProps) {
  const titleClass =
    tone === "destructive" ? "text-destructive" : "text-muted-foreground";
  const resolvedTitleClass =
    tone === "warning" ? "text-amber-700 dark:text-amber-300" : titleClass;

  return (
    <div
      className={cn(
        "flex flex-col gap-3 border-border border-t pt-3 first:border-t-0 first:pt-0 sm:flex-row sm:items-start sm:justify-between",
        tone === "warning" &&
          "rounded-[6px] border border-amber-500/30 bg-amber-500/10 p-3 first:border-t first:pt-3",
        tone === "destructive" &&
          "rounded-[6px] border border-destructive/30 bg-destructive/5 p-3 first:border-t first:pt-3",
        className
      )}
    >
      <div className="min-w-0 flex-1">
        <div className={cn("text-[13px]", resolvedTitleClass)}>{title}</div>
        {description && (
          <div className="mt-0.5 text-[11px] text-muted-foreground/70 leading-relaxed">
            {description}
          </div>
        )}
        {children && <div className="mt-2">{children}</div>}
      </div>
      {action && <div className="shrink-0 sm:pt-0.5">{action}</div>}
    </div>
  );
}
