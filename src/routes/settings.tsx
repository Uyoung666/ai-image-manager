import {
  createFileRoute,
  Outlet,
  useLocation,
  useNavigate,
} from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { SettingsSidebar } from "@/components/settings/SettingsSidebar";

function SettingsLayout() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();

  // Redirect /settings → /settings/appearance
  useEffect(() => {
    if (location.pathname === "/settings") {
      navigate({ to: "/settings/appearance", replace: true });
    }
  }, [location.pathname, navigate]);

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Header */}
      <div className="flex items-center gap-4 border-border border-b px-6 py-4">
        <button
          className="text-muted-foreground hover:text-foreground"
          onClick={() => navigate({ to: "/" })}
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <h1 className="font-semibold text-[18px] text-foreground">
          {t("settingsTitle")}
        </h1>
      </div>

      {/* Body: Sidebar + Content */}
      <div className="flex min-h-0 flex-1">
        <SettingsSidebar />
        <div className="min-h-0 flex-1 overflow-hidden" key={location.pathname}>
          <div className="animate-page-enter h-full">
            <Outlet />
          </div>
        </div>
      </div>
    </div>
  );
}

export const Route = createFileRoute("/settings")({
  component: SettingsLayout,
});
