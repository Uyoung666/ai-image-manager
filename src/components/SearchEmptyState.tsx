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
import { EmptyStateCard } from "@/components/EmptyStateCard";
import type { SearchMode } from "@/types/search";

interface ParsedTimeFilter {
  dateFrom: string;
  dateTo: string;
  keyword: string;
}

interface SearchEmptyStateProps {
  hasActiveFilters: boolean;
  hasAiVectors: boolean;
  indexedPhotos?: number;
  onClearFilters?: () => void;
  onClearSearch: () => void;
  onGoToAiSettings?: () => void;
  parsedTimeFilter?: ParsedTimeFilter | null;
  query: string;
  searchMode: SearchMode | null;
  semanticState?: "ready" | "partial" | "unavailable" | "error";
  totalPhotos?: number;
}

export function SearchEmptyState({
  searchMode,
  query,
  hasActiveFilters,
  hasAiVectors,
  parsedTimeFilter,
  onClearSearch,
  onClearFilters,
  onGoToAiSettings,
  semanticState,
  indexedPhotos = 0,
  totalPhotos = 0,
}: SearchEmptyStateProps) {
  const { t } = useTranslation();
  const aiState = semanticState ?? (hasAiVectors ? "ready" : "unavailable");

  if (searchMode === "text" && query.trim() && aiState !== "ready") {
    const isPartial = aiState === "partial";
    const isError = aiState === "error";
    return (
      <EmptyStateCard
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
          { label: t("emptyBrowseAll"), onClick: onClearSearch },
        ]}
        description={
          isError
            ? t("semanticSearchUnavailable")
            : isPartial
              ? t("semanticSearchPartial", {
                  indexed: indexedPhotos,
                  total: totalPhotos,
                })
              : t("emptyAiNotIndexedDesc")
        }
        icon={<Brain className="h-5 w-5" />}
        title={
          isError
            ? t("semanticSearchUnavailableTitle")
            : isPartial
              ? t("emptyAiPartialTitle", {
                  indexed: indexedPhotos,
                  total: totalPhotos,
                })
              : t("emptyAiNotIndexedTitle")
        }
      />
    );
  }

  if (parsedTimeFilter && query.trim()) {
    return (
      <EmptyStateCard
        actions={[
          {
            label: t("emptyClearTimeFilter"),
            onClick: onClearSearch,
            primary: true,
          },
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

  if (hasActiveFilters && query.trim()) {
    return (
      <EmptyStateCard
        actions={[
          {
            label: t("emptyKeepQueryOnly"),
            onClick: onClearFilters ?? onClearSearch,
            primary: true,
          },
        ]}
        description={t("emptyFilterAndQueryDesc", { query: truncate(query, 40) })}
        icon={<FilterX className="h-5 w-5" />}
        title={t("emptyFilterAndQueryTitle")}
      />
    );
  }

  if (searchMode === "exif" && hasActiveFilters) {
    return (
      <EmptyStateCard
        actions={[
          {
            label: t("emptyClearAllFilters"),
            onClick: onClearFilters ?? onClearSearch,
            primary: true,
          },
          { label: t("emptyBrowseAll"), onClick: onClearSearch },
        ]}
        description={t("emptyExifTooStrictDesc")}
        icon={<SlidersHorizontal className="h-5 w-5" />}
        title={t("emptyExifTooStrictTitle")}
      />
    );
  }

  if (searchMode === "image") {
    return (
      <EmptyStateCard
        actions={[{ label: t("emptyBrowseAll"), onClick: onClearSearch, primary: true }]}
        description={t("emptyImageSearchDesc")}
        icon={<ImageUp className="h-5 w-5" />}
        title={t("emptyImageSearchTitle")}
      />
    );
  }

  if (searchMode === "color") {
    return (
      <EmptyStateCard
        actions={[{ label: t("emptyBrowseAll"), onClick: onClearSearch, primary: true }]}
        description={t("emptyColorSearchDesc")}
        icon={<Filter className="h-5 w-5" />}
        title={t("emptyColorSearchTitle")}
      />
    );
  }

  return (
    <EmptyStateCard
      actions={[
        { label: t("emptyBrowseAll"), onClick: onClearSearch, primary: true },
        ...(hasActiveFilters && onClearFilters
          ? [{ label: t("emptyKeepQueryOnly"), onClick: onClearFilters }]
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

function truncate(text: string, maxLen: number): string {
  return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
}
