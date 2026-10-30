import { ArrowLeft, Info } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { CullArchiveActions } from "@/components/CullArchiveActions";
import { Archive } from "@/components/icons/archive";
import { IconMotionTrigger } from "@/components/icons/icon-motion";
import { Button } from "@/components/ui/button";
import { SmoothInput } from "@/components/ui/smooth-input";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export function CullListHeader({
  archived,
  count,
  search,
  onSearch,
  onHome,
  onArchive,
  scrolled,
  children,
}: {
  archived: boolean;
  count: number;
  search: string;
  onSearch: (value: string) => void;
  onHome: () => void;
  onArchive: () => void;
  scrolled: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const title = t(archived ? "cullProject.archive.title" : "cullTitle");
  return (
    <header
      className={`page-toolbar sticky top-0 z-20 grid min-w-0 shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 border-b px-3 py-3 sm:px-6 min-[1100px]:grid-cols-[minmax(0,1fr)_minmax(9rem,16rem)_auto] ${scrolled ? "is-scrolled" : ""}`}
      data-testid="cull-list-header"
    >
      <div
        className={`flex min-w-0 items-center gap-2 ${archived ? "" : "col-span-2 min-[1100px]:col-span-1"}`}
      >
        {!archived && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                aria-label={t("backToHome")}
                onClick={onHome}
                size="icon"
                variant="ghost"
              >
                <ArrowLeft className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("backToHome")}</TooltipContent>
          </Tooltip>
        )}
        <h1 className="min-w-0 font-semibold text-[18px] text-foreground">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                className="block max-w-full truncate text-left"
                type="button"
              >
                {title}
              </button>
            </TooltipTrigger>
            <TooltipContent>{title}</TooltipContent>
          </Tooltip>
        </h1>
        <span className="shrink-0 text-[13px] text-muted-foreground/70">
          {t("cullSessionCount", { count })}
        </span>
        {archived && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                aria-label={t("cullProject.archive.about")}
                size="icon"
                variant="ghost"
              >
                <Info className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {t("cullProject.archive.description")}
            </TooltipContent>
          </Tooltip>
        )}
      </div>
      <div
        className={`row-start-2 min-w-0 min-[1100px]:col-span-1 min-[1100px]:col-start-2 min-[1100px]:row-start-1 ${archived ? "col-span-2" : "col-start-1"}`}
        data-testid="cull-list-filters"
      >
        <SmoothInput
          aria-label={t("cullProject.archive.search")}
          className="h-8 rounded border border-input bg-transparent px-2 text-xs"
          maxLength={200}
          onChange={(event) => onSearch(event.target.value)}
          placeholder={t("cullProject.archive.search")}
          type="search"
          value={search}
          wrapperClassName="min-w-0 w-full"
        />
      </div>
      <div
        className={`col-start-2 flex max-w-full flex-wrap items-center justify-end gap-2 min-[1100px]:col-start-3 min-[1100px]:row-start-1 ${archived ? "row-start-1" : "row-start-2"}`}
      >
        {children}
        {archived ? (
          <CullArchiveActions onBack={onArchive} />
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <IconMotionTrigger asChild>
                <Button
                  aria-label={t("cullProject.archive.title")}
                  data-testid="cull-archive-list-link"
                  onClick={onArchive}
                  size="icon"
                  variant="ghost"
                >
                  <Archive className="h-4 w-4" />
                </Button>
              </IconMotionTrigger>
            </TooltipTrigger>
            <TooltipContent>{t("cullProject.archive.title")}</TooltipContent>
          </Tooltip>
        )}
      </div>
    </header>
  );
}
