import { FolderOpen } from "lucide-react";
import { useTranslation } from "react-i18next";

interface WelcomeProps {
  onAddFolder: () => void;
}

export function Welcome({ onAddFolder }: WelcomeProps) {
  const { t } = useTranslation();

  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="flex max-w-[420px] flex-col items-center space-y-8 text-center">
        {/* Icon */}
        <div className="flex h-20 w-20 items-center justify-center rounded-[12px] bg-card">
          <FolderOpen className="h-9 w-9 text-primary" />
        </div>

        {/* Title & steps */}
        <div className="space-y-4">
          <h1 className="font-[590] text-foreground text-[24px] tracking-[-0.02em]">
            {t("welcomeTitle")}
          </h1>
          <div className="space-y-3 text-left text-muted-foreground text-[14px] leading-relaxed">
            <div className="flex items-start gap-3">
              <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-card text-foreground text-[12px]">
                1
              </span>
              <span>{t("welcomeStep1")}</span>
            </div>
            <div className="flex items-start gap-3">
              <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-card text-foreground text-[12px]">
                2
              </span>
              <span>{t("welcomeStep2")}</span>
            </div>
            <div className="flex items-start gap-3">
              <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-card text-foreground text-[12px]">
                3
              </span>
              <span>{t("welcomeStep3")}</span>
            </div>
          </div>
        </div>

        {/* CTA */}
        <button
          className="inline-flex items-center gap-2 rounded-[6px] bg-primary px-5 py-2.5 font-[510] text-[14px] text-primary-foreground transition-opacity hover:opacity-90"
          onClick={onAddFolder}
        >
          <FolderOpen className="h-4 w-4" />
          {t("sidebarAddFolder")}
        </button>

        {/* Tip */}
        <p className="text-muted-foreground/70 text-[12px]">{t("welcomeTip")}</p>
      </div>
    </div>
  );
}
