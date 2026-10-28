import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { setSearchHistoryPreferences } from "@/actions/search-history";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { FilterDropdown } from "@/components/filter-dropdown";
import { SettingRow } from "@/components/settings/setting-row";
import { Switch } from "@/components/ui/switch";
import { useSearchHistory } from "@/features/search-bar/use-search-history";
import {
  SEARCH_HISTORY_LIMITS,
  type SearchHistoryPreferences,
} from "@/types/search-history";

export function SearchHistorySettings() {
  const { t } = useTranslation();
  const { preferences, ready, clearHistory, historyCount } = useSearchHistory();
  const [pending, setPending] = useState<SearchHistoryPreferences | null>(null);
  const [reduction, setReduction] = useState<SearchHistoryPreferences | null>(
    null
  );
  const value = pending ?? preferences;
  async function save(next: SearchHistoryPreferences) {
    setPending(next);
    try {
      await setSearchHistoryPreferences(next);
    } catch {
      toast.error(t("saveFailed"));
    } finally {
      setPending(null);
    }
  }
  return (
    <>
      <SettingRow
        action={
          <Switch
            ariaLabel={t("searchHistoryUi.enabled")}
            checked={value.enabled}
            disabled={!ready || pending !== null}
            onCheckedChange={(enabled) => save({ ...value, enabled })}
          />
        }
        description={t("searchHistoryUi.enabledHint")}
        title={t("searchHistoryUi.enabled")}
      />
      <SettingRow
        action={
          <FilterDropdown
            ariaLabel={t("searchHistoryUi.limit")}
            className="w-[160px] max-w-full"
            disabled={!ready || pending !== null}
            onChange={(limit) => {
              const next = {
                ...value,
                limit: Number(limit) as SearchHistoryPreferences["limit"],
              };
              if (historyCount > next.limit) {
                setReduction(next);
              } else {
                save(next);
              }
            }}
            options={SEARCH_HISTORY_LIMITS.map((limit) => ({
              label: t("searchHistoryUi.limitOption", { count: limit }),
              value: String(limit),
            }))}
            placeholder={t("searchHistoryUi.limit")}
            value={String(value.limit)}
          />
        }
        description={t("searchHistoryUi.limitHint")}
        title={t("searchHistoryUi.limit")}
      />
      <SettingRow
        action={
          <button
            className="max-w-full rounded border border-border px-3 py-1.5 text-[12px] text-foreground hover:bg-muted disabled:opacity-50"
            disabled={!ready}
            onClick={clearHistory}
            type="button"
          >
            {t("searchHistoryUi.clear")}
          </button>
        }
        description={t("searchHistoryUi.clearHint")}
        title={t("searchHistoryUi.clear")}
      />
      <ConfirmDialog
        confirmText={t("searchHistoryUi.reduceConfirm")}
        description={t("searchHistoryUi.reduceHint", {
          count: Math.max(0, historyCount - (reduction?.limit ?? historyCount)),
          limit: reduction?.limit,
        })}
        destructive
        onCancel={() => setReduction(null)}
        onConfirm={() => {
          if (reduction) {
            save(reduction);
            setReduction(null);
          }
        }}
        open={reduction !== null}
        title={t("searchHistoryUi.reduceTitle")}
      />
    </>
  );
}
