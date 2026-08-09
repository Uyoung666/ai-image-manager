import { useLocation, useNavigate } from "@tanstack/react-router";
import {
  Cloud,
  Compass,
  HardDrive,
  Image,
  Info,
  Layers,
  Paintbrush,
  RefreshCw,
  Settings,
  Zap,
} from "lucide-react";
import { Fragment } from "react";
import { useTranslation } from "react-i18next";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface NavItem {
  groupKey: string;
  icon: React.ComponentType<{ className?: string }>;
  keywords: string;
  labelKey: string;
  to: string;
}

const NAV_ITEMS: NavItem[] = [
  {
    groupKey: "settingsGroupAppearance",
    icon: Paintbrush,
    keywords:
      "\u5916\u89c2 \u4ea4\u4e92 \u4e3b\u9898 \u6df1\u8272 \u6d45\u8272 \u7cfb\u7edf \u8bed\u8a00 \u4e2d\u6587 \u82f1\u6587 \u7f29\u653e \u754c\u9762\u7f29\u653e \u641c\u7d22 \u5339\u914d \u7075\u654f\u5ea6 \u5bbd\u677e \u6807\u51c6 \u4e25\u683c \u52a8\u753b \u51cf\u5c11\u52a8\u753b appearance interaction theme dark light language chinese english scale zoom search sensitivity relaxed standard strict motion animation",
    labelKey: "settingsAppearance",
    to: "/settings/appearance",
  },
  {
    groupKey: "settingsGroupBehavior",
    icon: Settings,
    keywords:
      "\u5e94\u7528\u884c\u4e3a \u5173\u95ed \u5173\u95ed\u884c\u4e3a \u9000\u51fa \u6258\u76d8 \u6700\u5c0f\u5316 \u8bb0\u4f4f\u7a97\u53e3 \u4f4d\u7f6e \u5927\u5c0f \u5f00\u673a\u81ea\u542f \u542f\u52a8 \u4fa7\u8fb9\u680f \u6298\u53e0 \u9009\u7247 \u4fdd\u7559 \u6536\u85cf app behavior close quit tray minimize window bounds startup login sidebar collapse cull keep favorites",
    labelKey: "settingsBehavior",
    to: "/settings/behavior",
  },
  {
    groupKey: "settingsGroupPhotos",
    icon: Compass,
    keywords:
      "\u7167\u7247\u4f53\u9a8c \u6f2b\u6e38 \u95f2\u7f6e \u653e\u6620 \u56de\u5fc6 \u4e3b\u9898 wander idle slideshow memories theme",
    labelKey: "settingsWander",
    to: "/settings/wander",
  },
  {
    groupKey: "settingsGroupPhotos",
    icon: Layers,
    keywords:
      "\u7167\u7247\u4f53\u9a8c \u5e8f\u5217\u8bc6\u522b \u8fde\u62cd \u5ef6\u65f6\u6444\u5f71 \u8bc6\u522b burst timelapse sequence detection recognition",
    labelKey: "settingsSequenceDetection",
    to: "/settings/sequences",
  },
  {
    groupKey: "settingsGroupData",
    icon: HardDrive,
    keywords:
      "\u6570\u636e \u6027\u80fd \u7f13\u5b58 \u7f29\u7565\u56fe \u6e05\u7406 \u5b64\u7acb \u7d22\u5f15 \u65e0\u6548 \u6570\u636e\u5e93 \u6570\u636e\u76ee\u5f55 \u8fc1\u79fb cache thumbnail orphan index database directory clean storage",
    labelKey: "settingsStorage",
    to: "/settings/storage",
  },
  {
    groupKey: "settingsGroupData",
    icon: Zap,
    keywords:
      "\u6570\u636e \u6027\u80fd GPU \u663e\u5361 \u52a0\u901f \u4eba\u8138\u68c0\u6d4b directml face detection acceleration",
    labelKey: "gpuAcceleration",
    to: "/settings/acceleration",
  },
  {
    groupKey: "settingsGroupOutput",
    icon: Cloud,
    keywords:
      "\u8f93\u51fa \u540c\u6b65 \u4e91\u540c\u6b65 webdav s3 \u4e0a\u4f20 \u5b58\u50a8\u6876 cloud sync upload bucket",
    labelKey: "cloudSync",
    to: "/settings/cloud-sync",
  },
  {
    groupKey: "settingsGroupOutput",
    icon: Image,
    keywords:
      "\u8f93\u51fa \u540c\u6b65 \u6c34\u5370 \u6587\u5b57 \u56fe\u7247 \u900f\u660e\u5ea6 \u5927\u5c0f \u4f4d\u7f6e \u5b57\u4f53 watermark text image opacity font position",
    labelKey: "watermarkSettings",
    to: "/settings/watermark",
  },
  {
    groupKey: "settingsGroupUpdates",
    icon: RefreshCw,
    keywords:
      "\u66f4\u65b0 \u7248\u672c \u5347\u7ea7 \u4e0b\u8f7d \u4ee3\u7406 \u91cd\u542f \u81ea\u52a8\u66f4\u65b0 \u63d0\u9192 update version upgrade download proxy restart automatic reminder",
    labelKey: "settingsUpdate",
    to: "/settings/update",
  },
  {
    groupKey: "settingsGroupUpdates",
    icon: Info,
    keywords:
      "\u66f4\u65b0 \u5173\u4e8e \u7248\u672c \u8bb8\u53ef\u8bc1 \u4f5c\u8005 github \u4f9d\u8d56 about version license author dependencies",
    labelKey: "settingsAbout",
    to: "/settings/about",
  },
];

const GROUP_ORDER = [
  "settingsGroupAppearance",
  "settingsGroupBehavior",
  "settingsGroupPhotos",
  "settingsGroupData",
  "settingsGroupOutput",
  "settingsGroupUpdates",
];

export { GROUP_ORDER as SETTINGS_GROUP_ORDER, NAV_ITEMS as SETTINGS_NAV_ITEMS };

export function filterSettingsNavigationItems(
  query: string,
  translate: (key: string) => string
) {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return [];
  }

  return NAV_ITEMS.filter((item) =>
    `${translate(item.labelKey)} ${translate(item.groupKey)} ${item.keywords}`
      .toLowerCase()
      .includes(normalizedQuery)
  );
}

export function SettingsSidebar() {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const groupedItems = GROUP_ORDER.map((groupKey) => ({
    groupKey,
    items: NAV_ITEMS.filter((item) => item.groupKey === groupKey),
  })).filter((group) => group.items.length > 0);

  return (
    <nav className="flex min-h-0 w-[200px] shrink-0 flex-col gap-1 overflow-y-auto overflow-x-hidden overscroll-contain border-border border-r p-3 max-[900px]:w-[64px] max-[900px]:items-center max-[900px]:px-2">
      {groupedItems.map((group) => (
        <Fragment key={group.groupKey}>
          <div className="shrink-0 px-3 pt-2 pb-1 font-medium text-[10px] text-muted-foreground/45 uppercase tracking-wide first:pt-0 max-[900px]:hidden">
            {t(group.groupKey)}
          </div>
          {group.items.map((item) => {
            const isActive = location.pathname === item.to;
            const label = t(item.labelKey);
            return (
              <Tooltip key={item.to}>
                <TooltipTrigger asChild>
                  <button
                    className={`flex w-full shrink-0 items-center gap-2.5 rounded-[6px] px-3 py-1.5 text-left text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50 max-[900px]:h-9 max-[900px]:w-9 max-[900px]:justify-center max-[900px]:px-0 ${
                      isActive
                        ? "bg-primary/15 text-primary"
                        : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
                    }`}
                    onClick={() => {
                      navigate({ to: item.to });
                    }}
                    type="button"
                  >
                    <item.icon className="h-4 w-4 shrink-0" />
                    <span className="min-w-0 truncate max-[900px]:hidden">
                      {label}
                    </span>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right">{label}</TooltipContent>
              </Tooltip>
            );
          })}
        </Fragment>
      ))}
    </nav>
  );
}
