import { useLocation, useNavigate } from "@tanstack/react-router";
import {
  Cloud,
  HardDrive,
  Image,
  Info,
  Paintbrush,
  RefreshCw,
  Search,
  X,
  Zap,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

interface NavItem {
  icon: React.ComponentType<{ className?: string }>;
  keywords: string;
  labelKey: string;
  to: string;
}

const NAV_ITEMS: NavItem[] = [
  {
    icon: Paintbrush,
    keywords:
      "主题 深色 浅色 暗色 语言 中文 英文 开机自启 启动 侧边栏 折叠 theme dark light language startup sidebar collapse",
    labelKey: "settingsAppearance",
    to: "/settings/appearance",
  },
  {
    icon: HardDrive,
    keywords:
      "缓存 缩略图 清理 孤立 孤儿 索引 无效 数据库 数据目录 迁移 cache thumbnail orphan index database directory clean storage",
    labelKey: "settingsStorage",
    to: "/settings/storage",
  },
  {
    icon: Zap,
    keywords: "gpu 显卡 加速 directml 人脸 检测 face detection acceleration",
    labelKey: "gpuAcceleration",
    to: "/settings/acceleration",
  },
  {
    icon: Cloud,
    keywords: "云同步 webdav s3 上传 存储桶 cloud sync upload bucket",
    labelKey: "cloudSync",
    to: "/settings/cloud-sync",
  },
  {
    icon: Image,
    keywords:
      "水印 文字 图片 透明度 大小 位置 字体 watermark text image opacity font position",
    labelKey: "watermarkSettings",
    to: "/settings/watermark",
  },
  {
    icon: RefreshCw,
    keywords:
      "更新 版本 升级 下载 代理 重启 update version upgrade download proxy restart",
    labelKey: "settingsUpdate",
    to: "/settings/update",
  },
  {
    icon: Info,
    keywords:
      "关于 版本 许可 作者 github 依赖 about version license author dependencies",
    labelKey: "settingsAbout",
    to: "/settings/about",
  },
];

export function SettingsSidebar() {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");

  const filteredItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      return NAV_ITEMS;
    }
    return NAV_ITEMS.filter((item) => {
      const haystack = `${t(item.labelKey)} ${item.keywords}`.toLowerCase();
      return haystack.includes(q);
    });
  }, [query, t]);

  return (
    <nav className="flex w-[200px] shrink-0 flex-col gap-0.5 overflow-y-auto border-border border-r p-3">
      {/* Search */}
      <div className="relative mb-2">
        <Search className="pointer-events-none absolute top-1/2 left-2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/40" />
        <input
          className="h-8 w-full rounded-[6px] border border-input bg-background py-1 pr-7 pl-7 text-[12px] text-foreground outline-none placeholder:text-muted-foreground/40 focus:border-primary"
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("settingsSearchPlaceholder")}
          value={query}
        />
        {query && (
          <button
            className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded p-0.5 text-muted-foreground/40 hover:text-muted-foreground"
            onClick={() => setQuery("")}
            type="button"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>

      {filteredItems.length === 0 && (
        <p className="px-1 py-3 text-center text-[11px] text-muted-foreground/50">
          {t("noResults")}
        </p>
      )}

      {filteredItems.map((item) => {
        const isActive = location.pathname === item.to;
        return (
          <button
            className={`flex items-center gap-2.5 rounded-[6px] px-3 py-1.5 text-left text-[13px] transition-colors ${
              isActive
                ? "bg-primary/15 text-primary"
                : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
            }`}
            key={item.to}
            onClick={() => {
              navigate({ to: item.to });
              setQuery("");
            }}
            type="button"
          >
            <item.icon className="h-4 w-4 shrink-0" />
            <span>{t(item.labelKey)}</span>
          </button>
        );
      })}
    </nav>
  );
}
