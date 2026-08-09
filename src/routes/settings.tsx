import {
  createFileRoute,
  Outlet,
  redirect,
  useLocation,
  useNavigate,
} from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { useTranslation } from "react-i18next";
import { SettingsSidebar } from "@/components/settings/SettingsSidebar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

function SettingsLayout() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden bg-background">
      {/* Header */}
      <div className="flex shrink-0 items-center gap-3 border-border border-b px-3 py-2.5 sm:gap-4 sm:px-6 sm:py-4 min-[480px]:px-4 min-[480px]:py-3">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              className="flex h-8 w-8 items-center justify-center rounded-[6px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50"
              onClick={() => navigate({ to: "/" })}
              type="button"
            >
              <ArrowLeft className="h-5 w-5" />
              <span className="sr-only">{t("settingsBackHome")}</span>
            </button>
          </TooltipTrigger>
          <TooltipContent>{t("settingsBackHome")}</TooltipContent>
        </Tooltip>
        <h1 className="min-w-0 font-semibold text-[18px] text-foreground leading-tight [overflow-wrap:anywhere]">
          {t("settingsTitle")}
        </h1>
      </div>

      {/* Body: Sidebar + Content */}
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <SettingsSidebar />
        <div
          className="min-h-0 min-w-0 flex-1 overflow-hidden"
          key={location.pathname}
        >
          <div className="h-full min-w-0 animate-page-enter motion-reduce:animate-none">
            <Outlet />
          </div>
        </div>
      </div>
    </div>
  );
}

export const Route = createFileRoute("/settings")({
  beforeLoad: ({ location }) => {
    if (location.pathname === "/settings") {
      throw redirect({ to: "/settings/appearance", replace: true });
    }
  },
  component: SettingsLayout,
});
