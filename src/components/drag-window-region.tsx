import { type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getPlatform } from "@/actions/app";
import {
  closeWindow,
  getIsMaximized,
  maximizeWindow,
  minimizeWindow,
} from "@/actions/window";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import icon from "../../assets/icon.png";

interface DragWindowRegionProps {
  title?: ReactNode;
}

export default function DragWindowRegion({ title }: DragWindowRegionProps) {
  const { t } = useTranslation();
  const [platform, setPlatform] = useState<string | null>(null);

  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    let active = true;

    getPlatform()
      .then((value) => {
        if (!active) {
          return;
        }

        setPlatform(value);
      })
      .catch((error) => {
        console.error("Failed to detect platform", error);
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    getIsMaximized()
      .then(setIsMaximized)
      .catch(() => {
        /* window may not be available yet */
      });
  }, []);

  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (e.data?.channel === "window:maximize-change") {
        setIsMaximized(e.data.isMaximized);
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  const isMacOS = platform === "darwin";

  return (
    <div
      className="flex w-full min-w-0 items-stretch justify-between"
      data-surface="toolbar"
    >
      <button
        aria-label={t("windowMaximize")}
        className="draglayer min-w-0 flex-1 border-0 bg-transparent p-0 text-left"
        onDoubleClick={maximizeWindow}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            maximizeWindow();
          }
        }}
        tabIndex={0}
        type="button"
      >
        {title && !isMacOS && (
          <div className="flex min-w-0 flex-1 select-none items-center gap-1.5 whitespace-nowrap p-2 text-muted-foreground text-xs">
            <img
              alt=""
              className="h-3.5 w-3.5"
              height={14}
              src={icon}
              width={14}
            />
            <span className="min-w-0 truncate">{title}</span>
          </div>
        )}
        {isMacOS && <div className="flex flex-1" style={{ height: 28 }} />}
      </button>
      {!isMacOS && (
        <div className="window-buttons shrink-0">
          <WindowButtons isMaximized={isMaximized} />
        </div>
      )}
    </div>
  );
}

function WindowButtons({ isMaximized }: { isMaximized: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="flex">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            aria-label={t("windowMinimize")}
            className="p-2 hover:bg-muted"
            onClick={minimizeWindow}
            type="button"
          >
            <svg
              aria-hidden="true"
              height="12"
              role="img"
              viewBox="0 0 12 12"
              width="12"
            >
              <rect fill="currentColor" height="1" width="10" x="1" y="6" />
            </svg>
          </button>
        </TooltipTrigger>
        <TooltipContent>{t("windowMinimize")}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            aria-label={isMaximized ? t("windowRestore") : t("windowMaximize")}
            className="p-2 hover:bg-muted"
            onClick={maximizeWindow}
            type="button"
          >
            <svg
              aria-hidden="true"
              height="12"
              role="img"
              viewBox="0 0 12 12"
              width="12"
            >
              {isMaximized ? (
                <>
                  <rect
                    fill="none"
                    height="7"
                    stroke="currentColor"
                    width="7"
                    x="3.5"
                    y="1.5"
                  />
                  <rect
                    fill="currentColor"
                    height="7"
                    width="7"
                    x="1.5"
                    y="3.5"
                  />
                </>
              ) : (
                <rect
                  fill="none"
                  height="9"
                  stroke="currentColor"
                  width="9"
                  x="1.5"
                  y="1.5"
                />
              )}
            </svg>
          </button>
        </TooltipTrigger>
        <TooltipContent>
          {isMaximized ? t("windowRestore") : t("windowMaximize")}
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            aria-label={t("close")}
            className="p-2 hover:bg-destructive/20 hover:text-destructive"
            onClick={closeWindow}
            type="button"
          >
            <svg
              aria-hidden="true"
              height="12"
              role="img"
              viewBox="0 0 12 12"
              width="12"
            >
              <polygon
                fill="currentColor"
                fillRule="evenodd"
                points="11 1.576 6.583 6 11 10.424 10.424 11 6 6.583 1.576 11 1 10.424 5.417 6 1 1.576 1.576 1 6 5.417 10.424 1"
              />
            </svg>
          </button>
        </TooltipTrigger>
        <TooltipContent>{t("close")}</TooltipContent>
      </Tooltip>
    </div>
  );
}
