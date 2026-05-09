import { useTranslation } from "react-i18next";
import { FolderOpen, Sparkles, Search } from "lucide-react";

interface WelcomeProps {
  onAddFolder: () => void;
  onAIIndex: () => void;
  hasPhotos: boolean;
}

export function Welcome({ onAddFolder, onAIIndex, hasPhotos }: WelcomeProps) {
  const { t } = useTranslation();

  if (hasPhotos) return null;

  return (
    <div className="flex items-center justify-center h-full p-8">
      <div className="flex flex-col items-center max-w-[420px] text-center space-y-8">
        {/* Icon */}
        <div className="w-20 h-20 rounded-[20px] bg-[#5e6ad2]/10 flex items-center justify-center">
          <FolderOpen className="w-9 h-9 text-[#5e6ad2]" />
        </div>

        {/* Title & steps */}
        <div className="space-y-4">
          <h1 className="text-[24px] font-[590] text-[#f7f8f8] tracking-[-0.02em]">
            {t("welcomeTitle")}
          </h1>
          <div className="text-left space-y-3 text-[#a1a1aa] text-[14px] leading-relaxed">
            <div className="flex items-start gap-3">
              <span className="flex-shrink-0 w-6 h-6 rounded-full bg-[#1c1e22] flex items-center justify-center text-[12px] text-[#f7f8f8]">
                1
              </span>
              <span>{t("welcomeStep1")}</span>
            </div>
            <div className="flex items-start gap-3">
              <span className="flex-shrink-0 w-6 h-6 rounded-full bg-[#1c1e22] flex items-center justify-center text-[12px] text-[#f7f8f8]">
                2
              </span>
              <span>{t("welcomeStep2")}</span>
            </div>
            <div className="flex items-start gap-3">
              <span className="flex-shrink-0 w-6 h-6 rounded-full bg-[#1c1e22] flex items-center justify-center text-[12px] text-[#f7f8f8]">
                3
              </span>
              <span>{t("welcomeStep3")}</span>
            </div>
          </div>
        </div>

        {/* CTA */}
        <button
          onClick={onAddFolder}
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-[6px] bg-[#5e6ad2] text-white text-[14px] font-[510] hover:opacity-90 transition-opacity"
        >
          <FolderOpen className="w-4 h-4" />
          {t("sidebarAddFolder")}
        </button>

        {/* Tip */}
        <p className="text-[#6b6b75] text-[12px]">{t("welcomeTip")}</p>
      </div>
    </div>
  );
}
