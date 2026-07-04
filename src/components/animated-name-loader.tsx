import { useTranslation } from "react-i18next";
import { openExternalLink } from "@/actions/shell";

const PROJECT_URL = "https://ai-image-manager.uyoungvision.cn/";

export function AnimatedNameLoader() {
  const { t } = useTranslation();
  return (
    <button
      className="group relative flex items-center justify-center font-bold text-sm text-zinc-600"
      onClick={() => openExternalLink(PROJECT_URL)}
      type="button"
    >
      {/* Tooltip — appears on hover */}
      <div className="absolute -translate-y-[300%] skew-y-[20deg] opacity-0 shadow-md duration-500 group-hover:-translate-y-[150%] group-hover:skew-y-0 group-hover:opacity-100 group-hover:delay-500">
        <div className="flex items-center gap-1 rounded-md bg-lime-200 p-2">
          <svg
            aria-label="globe"
            className="stroke-zinc-600"
            fill="none"
            height="20px"
            viewBox="0 0 24 24"
            width="20px"
            xmlns="http://www.w3.org/2000/svg"
          >
            <circle cx="12" cy="12" r="9" strokeLinejoin="round" />
            <path
              d="M12 3C12 3 8.5 6 8.5 12C8.5 18 12 21 12 21"
              strokeLinejoin="round"
            />
            <path
              d="M12 3C12 3 15.5 6 15.5 12C15.5 18 12 21 12 21"
              strokeLinejoin="round"
            />
            <path d="M3 12H21" strokeLinejoin="round" />
            <path d="M19.5 7.5H4.5" strokeLinejoin="round" />
            <g filter="url(#filter0_d_15_556)">
              <path d="M19.5 16.5H4.5" strokeLinejoin="round" />
            </g>
            <defs>
              <filter
                colorInterpolationFilters="sRGB"
                filterUnits="userSpaceOnUse"
                height="3"
                id="filter0_d_15_556"
                width="17"
                x="3.5"
                y="16"
              >
                <feFlood floodOpacity="0" result="BackgroundImageFix" />
                <feColorMatrix
                  in="SourceAlpha"
                  result="hardAlpha"
                  type="matrix"
                  values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
                />
                <feOffset dy="1" />
                <feGaussianBlur stdDeviation="0.5" />
                <feColorMatrix
                  type="matrix"
                  values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.1 0"
                />
                <feBlend
                  in2="BackgroundImageFix"
                  mode="normal"
                  result="effect1_dropShadow_15_556"
                />
                <feBlend
                  in="SourceGraphic"
                  in2="effect1_dropShadow_15_556"
                  mode="normal"
                  result="shape"
                />
              </filter>
            </defs>
          </svg>
          <span className="whitespace-nowrap">
            ai-image-manager.uyoungvision.cn
          </span>
        </div>
        <div className="absolute bottom-0 left-1/2 translate-x-full translate-y-1/2 rotate-45 bg-lime-200 p-1 shadow-md" />
        <div className="absolute top-0 left-0 h-full w-full rounded-md bg-white duration-500 group-hover:scale-[115%] group-hover:opacity-0 group-hover:delay-700">
          <div className="absolute bottom-0 left-1/2 translate-x-full translate-y-1/2 rotate-45 border-white border-r border-b bg-white p-1" />
        </div>
      </div>

      {/* Main button */}
      <div className="flex cursor-pointer items-center rounded-full bg-gradient-to-br from-lime-200 to-yellow-200 p-3 shadow-md duration-300 group-hover:gap-2">
        <svg
          aria-label="share"
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
  );
}
