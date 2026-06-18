import {
  Brain,
  Calendar,
  Filter,
  FilterX,
  ImageUp,
  Search,
  SlidersHorizontal,
} from "lucide-react";
import { useTranslation } from "react-i18next";

interface ParsedTimeFilter {
  dateFrom: string;
  dateTo: string;
  keyword: string;
}

interface SearchEmptyStateProps {
  /** 是否有活跃的 EXIF 过滤条件 */
  hasActiveFilters: boolean;
  /** AI 向量数据库是否已就绪且有向量 */
  hasAiVectors: boolean;
  /** 仅清除 EXIF 过滤条件 */
  onClearFilters?: () => void;
  /** 清除所有搜索条件 */
  onClearSearch: () => void;
  /** 导航到 AI 设置 */
  onGoToAiSettings?: () => void;
  /** 自然语言时间过滤解析结果（如果查询被解析出时间范围） */
  parsedTimeFilter?: ParsedTimeFilter | null;
  /** 搜索关键词 */
  query: string;
  /** 当前搜索模式 */
  searchMode: "text" | "image" | "exif" | "color" | null;
}

/**
 * 分级空状态组件 — 根据搜索模式和上下文提供差异化引导。
 *
 * 避免千篇一律的 "没有找到结果"，代之以可操作的建议步骤。
 */
export function SearchEmptyState({
  searchMode,
  query,
  hasActiveFilters,
  hasAiVectors,
  parsedTimeFilter,
  onClearSearch,
  onClearFilters,
  onGoToAiSettings,
}: SearchEmptyStateProps) {
  const { t } = useTranslation();

  // ── 场景 1: AI 未索引 + 文本搜索 ─────────────────
  if (searchMode === "text" && !hasAiVectors && query.trim()) {
    return (
      <EmptyCard
        actions={[
          ...(onGoToAiSettings
            ? [
                {
                  label: t("emptyGoToAiSettings"),
                  onClick: onGoToAiSettings,
                  primary: true,
                },
              ]
            : []),
          {
            label: t("emptyBrowseAll"),
            onClick: onClearSearch,
          },
        ]}
        description={t("emptyAiNotIndexedDesc")}
        icon={<Brain className="h-5 w-5" />}
        title={t("emptyAiNotIndexedTitle")}
      />
    );
  }

  // ── 场景 2: 自然语言时间过滤被解析 + 无结果 ──────
  if (parsedTimeFilter && query.trim()) {
    return (
      <EmptyCard
        actions={[
          {
            label: t("emptyClearTimeFilter"),
            onClick: onClearSearch,
            primary: true,
          },
          ...(onClearFilters
            ? [
                {
                  label: t("emptyExpandTimeRange"),
                  onClick: onClearFilters,
                },
              ]
            : []),
        ]}
        description={t("emptyTimeFilterDesc", {
          from: parsedTimeFilter.dateFrom,
          to: parsedTimeFilter.dateTo,
        })}
        icon={<Calendar className="h-5 w-5" />}
        title={t("emptyTimeFilterTitle", {
          keyword: parsedTimeFilter.keyword || t("emptyTimeRangeFallback"),
        })}
      />
    );
  }

  // ── 场景 3: EXIF 过滤 + 文本搜索 ────────────────
  if (hasActiveFilters && query.trim()) {
    return (
      <EmptyCard
        actions={[
          {
            label: t("emptyClearAllFilters"),
            onClick: onClearFilters || onClearSearch,
            primary: true,
          },
          {
            label: t("emptyKeepQueryOnly"),
            onClick: onClearFilters || onClearSearch,
          },
        ]}
        description={t("emptyFilterAndQueryDesc", {
          query: truncate(query, 40),
        })}
        icon={<FilterX className="h-5 w-5" />}
        title={t("emptyFilterAndQueryTitle")}
      />
    );
  }

  // ── 场景 4: 纯 EXIF 过滤（无文本查询）───────────
  if (searchMode === "exif" && hasActiveFilters) {
    return (
      <EmptyCard
        actions={[
          {
            label: t("emptyClearAllFilters"),
            onClick: onClearFilters || onClearSearch,
            primary: true,
          },
          {
            label: t("emptyBrowseAll"),
            onClick: onClearSearch,
          },
        ]}
        description={t("emptyExifTooStrictDesc")}
        icon={<SlidersHorizontal className="h-5 w-5" />}
        title={t("emptyExifTooStrictTitle")}
      />
    );
  }

  // ── 场景 5: 以图搜图无结果 ─────────────────────
  if (searchMode === "image") {
    return (
      <EmptyCard
        actions={[
          {
            label: t("emptyBrowseAll"),
            onClick: onClearSearch,
            primary: true,
          },
        ]}
        description={t("emptyImageSearchDesc")}
        icon={<ImageUp className="h-5 w-5" />}
        title={t("emptyImageSearchTitle")}
      />
    );
  }

  // ── 场景 6: 颜色搜索无结果 ─────────────────────
  if (searchMode === "color") {
    return (
      <EmptyCard
        actions={[
          {
            label: t("emptyBrowseAll"),
            onClick: onClearSearch,
            primary: true,
          },
        ]}
        description={t("emptyColorSearchDesc")}
        icon={<Filter className="h-5 w-5" />}
        title={t("emptyColorSearchTitle")}
      />
    );
  }

  // ── 默认: 通用文本搜索无结果 ───────────────────
  return (
    <EmptyCard
      actions={[
        {
          label: t("emptyBrowseAll"),
          onClick: onClearSearch,
          primary: true,
        },
        ...(hasActiveFilters && onClearFilters
          ? [
              {
                label: t("emptyClearAllFilters"),
                onClick: onClearFilters,
              },
            ]
          : []),
      ]}
      description={
        hasActiveFilters
          ? t("emptySearchDescWithFilters")
          : t("emptySearchDescription")
      }
      icon={<Search className="h-5 w-5" />}
      title={t("emptySearchTitle")}
    />
  );
}

// ── 子组件: 空状态卡片 ────────────────────────────

function EmptyCard({
  icon,
  title,
  description,
  actions,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  actions: Array<{ label: string; onClick: () => void; primary?: boolean }>;
}) {
  return (
    <div className="flex flex-col items-center gap-4 text-center">
      {/* 图标 */}
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
        <span className="text-muted-foreground/60">{icon}</span>
      </div>

      {/* 标题 + 描述 */}
      <div className="space-y-1.5">
        <p className="font-medium text-[14px] text-foreground">{title}</p>
        <p className="max-w-[320px] text-[12px] text-muted-foreground/70 leading-relaxed">
          {description}
        </p>
      </div>

      {/* 操作按钮 */}
      {actions.length > 0 && (
        <div className="flex flex-wrap items-center justify-center gap-2">
          {actions.map((action, i) => (
            <button
              className={`rounded-[6px] px-3 py-1.5 font-medium text-[12px] transition-colors ${
                action.primary
                  ? "bg-primary text-primary-foreground hover:bg-primary/90"
                  : "border border-border bg-card text-foreground hover:bg-foreground/5"
              }`}
              key={i}
              onClick={action.onClick}
              type="button"
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function truncate(text: string, maxLen: number): string {
  return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
}
