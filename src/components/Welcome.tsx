import { FolderOpen } from "lucide-react";
import { useTranslation } from "react-i18next";

interface WelcomeProps {
  disabled?: boolean;
  onAddFolder: () => void;
}

export function Welcome({ onAddFolder, disabled }: WelcomeProps) {
  const { t } = useTranslation();

  return (
    <div className="welcome-empty-state flex flex-1 items-center justify-center p-8">
      <div className="flex max-w-[420px] flex-col items-center space-y-8 text-center">
        {/* Icon */}
        <div className="flex h-20 w-20 items-center justify-center rounded-[12px] bg-card">
          <FolderOpen className="h-9 w-9 text-primary" />
        </div>

        {/* Title & steps */}
        <div className="space-y-4">
          <h1 className="font-semibold text-[24px] text-foreground tracking-[-0.02em]">
            {t("welcomeTitle")}
          </h1>
          <div className="space-y-3 text-left text-[14px] text-muted-foreground leading-relaxed">
            <div className="flex items-start gap-3">
              <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-card text-[12px] text-foreground">
                1
              </span>
              <span>{t("welcomeStep1")}</span>
            </div>
            <div className="flex items-start gap-3">
              <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-card text-[12px] text-foreground">
                2
              </span>
              <span>{t("welcomeStep2")}</span>
            </div>
            <div className="flex items-start gap-3">
              <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-card text-[12px] text-foreground">
                3
              </span>
              <span>{t("welcomeStep3")}</span>
            </div>
          </div>
        </div>

        {/* CTA */}
        <button
          className="inline-flex items-center gap-2 rounded-[6px] bg-primary px-5 py-2.5 font-medium text-[14px] text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
          disabled={disabled}
          onClick={onAddFolder}
          type="button"
        >
          <FolderOpen className="h-4 w-4" />
          {t("sidebarAddFolder")}
        </button>

        {/* Tip */}
        <p className="text-[12px] text-muted-foreground/70">
          {t("welcomeTip")}
        </p>
      </div>
    </div>
  );
}
