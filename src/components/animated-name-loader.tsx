import { useTranslation } from "react-i18next";
import { openExternalLink } from "@/actions/shell";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const PROJECT_URL = "https://ai-image-manager.uyoungvision.cn/";

export function AnimatedNameLoader() {
  const { t } = useTranslation();

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          aria-label={t("settingsVisitWebsite")}
          className="group relative flex items-center justify-center font-bold text-sm text-zinc-600"
          onClick={() => openExternalLink(PROJECT_URL)}
          type="button"
        >
          <div className="flex cursor-pointer items-center rounded-full bg-gradient-to-br from-lime-200 to-yellow-200 p-3 shadow-md duration-300 group-hover:gap-2">
            <svg
              aria-hidden="true"
              className="fill-zinc-600"
              fill="none"
              height="20px"
              viewBox="0 0 24 24"
              width="20px"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path
                d="M15.4306 7.70172C7.55045 7.99826 3.43929 15.232 2.17021 19.3956C2.07701 19.7014 2.31139 20 2.63107 20C2.82491 20 3.0008 19.8828 3.08334 19.7074C6.04179 13.4211 12.7066 12.3152 15.514 12.5639C15.7583 12.5856 15.9333 12.7956 15.9333 13.0409V15.1247C15.9333 15.5667 16.4648 15.7913 16.7818 15.4833L20.6976 11.6784C20.8723 11.5087 20.8993 11.2378 20.7615 11.037L16.8456 5.32965C16.5677 4.92457 15.9333 5.12126 15.9333 5.61253V7.19231C15.9333 7.46845 15.7065 7.69133 15.4306 7.70172Z"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span className="text-[0px] duration-300 group-hover:text-sm">
              {t("settingsVisitWebsite")}
            </span>
          </div>
        </button>
      </TooltipTrigger>
      <TooltipContent>{t("settingsVisitWebsite")}</TooltipContent>
    </Tooltip>
  );
}
