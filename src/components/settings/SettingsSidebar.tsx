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
    groupKey: "settingsGroupGeneral",
    icon: Paintbrush,
    keywords:
      "主题 深色 浅色 暗色 语言 中文 英文 开机自启 启动 侧边栏 折叠 theme dark light language startup sidebar collapse",
    labelKey: "settingsAppearance",
    to: "/settings/appearance",
  },
  {
    groupKey: "settingsGroupGeneral",
    icon: Compass,
    keywords: "漫游 闲置 放映 回忆 主题 wander idle slideshow memories theme",
    labelKey: "settingsWander",
    to: "/settings/wander",
  },
  {
    groupKey: "settingsGroupSystem",
    icon: Layers,
    keywords:
      "序列 识别 连拍 延时摄影 burst timelapse sequence detection recognition",
    labelKey: "settingsSequenceDetection",
    to: "/settings/sequences",
  },
  {
    groupKey: "settingsGroupSystem",
    icon: HardDrive,
    keywords:
      "缓存 缩略图 清理 孤立 索引 无效 数据库 数据目录 迁移 cache thumbnail orphan index database directory clean storage",
    labelKey: "settingsStorage",
    to: "/settings/storage",
  },
  {
    groupKey: "settingsGroupSystem",
    icon: Zap,
    keywords: "gpu 显卡 加速 directml 人脸 检测 face detection acceleration",
    labelKey: "gpuAcceleration",
    to: "/settings/acceleration",
  },
  {
    groupKey: "settingsGroupExport",
    icon: Cloud,
    keywords: "云同步 webdav s3 上传 存储桶 cloud sync upload bucket",
    labelKey: "cloudSync",
    to: "/settings/cloud-sync",
  },
  {
    groupKey: "settingsGroupExport",
    icon: Image,
    keywords:
      "水印 文字 图片 透明度 大小 位置 字体 watermark text image opacity font position",
    labelKey: "watermarkSettings",
    to: "/settings/watermark",
  },
  {
    groupKey: "settingsGroupSystem",
    icon: RefreshCw,
    keywords:
      "更新 版本 升级 下载 代理 重启 update version upgrade download proxy restart",
    labelKey: "settingsUpdate",
    to: "/settings/update",
  },
  {
    groupKey: "settingsGroupGeneral",
    icon: Info,
    keywords:
      "关于 版本 许可 作者 github 依赖 about version license author dependencies",
    labelKey: "settingsAbout",
    to: "/settings/about",
  },
];

const GROUP_ORDER = [
  "settingsGroupGeneral",
  "settingsGroupExport",
  "settingsGroupSystem",
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
    <nav className="flex w-[200px] shrink-0 flex-col gap-1 overflow-y-auto border-border border-r p-3 max-[760px]:w-[60px] max-[760px]:items-center max-[760px]:px-2">
      {groupedItems.map((group) => (
        <Fragment key={group.groupKey}>
          <div className="px-3 pt-2 pb-1 font-medium text-[10px] text-muted-foreground/45 uppercase tracking-wide first:pt-0 max-[760px]:hidden">
            {t(group.groupKey)}
          </div>
          {group.items.map((item) => {
            const isActive = location.pathname === item.to;
            const label = t(item.labelKey);
            return (
              <Tooltip key={item.to}>
                <TooltipTrigger asChild>
                  <button
                    className={`flex w-full items-center gap-2.5 rounded-[6px] px-3 py-1.5 text-left text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50 max-[760px]:h-9 max-[760px]:w-9 max-[760px]:justify-center max-[760px]:px-0 ${
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
                    <span className="min-w-0 truncate max-[760px]:hidden">
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
