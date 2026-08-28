import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { getAvailableLocales, setAppLocale } from "@/actions/localization";
import { FilterDropdown } from "@/components/filter-dropdown";
import {
  BUILTIN_LOCALE_OPTIONS,
  type LocaleOption,
} from "@/localization/catalog";
import { cn } from "@/utils/tailwind";

export type LanguageOption = LocaleOption;

export interface LangToggleProps {
  className?: string;
  disabled?: boolean;
  languages?: readonly LanguageOption[];
  onError?: (error: unknown) => void;
  onLanguageChange?: (
    locale: string,
    providerPluginId: string | null
  ) => void | Promise<void>;
  value?: string;
}

interface SelectableLanguageOption extends LanguageOption {
  value: string;
}

function optionValue(option: LanguageOption): string {
  return `${option.pluginId}:${option.locale}`;
}

function optionLabel(option: LanguageOption): string {
  return `${option.nativeName} (${option.locale})`;
}

function mergeOptions(
  options: readonly LanguageOption[]
): SelectableLanguageOption[] {
  const merged = new Map<string, LanguageOption>();
  for (const option of [...BUILTIN_LOCALE_OPTIONS, ...options]) {
    merged.set(optionValue(option), option);
  }
  return [...merged.values()].map((option) => ({
    ...option,
    value: optionValue(option),
  }));
}

function selectedOptionValue(
  options: readonly SelectableLanguageOption[],
  currentLanguage: string
): string {
  const exact = options.find(
    (option) => option.locale === currentLanguage && option.builtIn
  );
  return (
    exact?.value ??
    options.find((option) => option.locale === currentLanguage)?.value ??
    currentLanguage
  );
}

export default function LangToggle({
  className,
  disabled = false,
  languages,
  onError,
  onLanguageChange,
  value,
}: LangToggleProps) {
  const { i18n, t } = useTranslation();
  const [loadedLanguages, setLoadedLanguages] = useState<
    readonly LanguageOption[]
  >([]);
  const [selectedOverride, setSelectedOverride] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [changing, setChanging] = useState(false);
  const availableLanguages = useMemo(
    () => mergeOptions(languages ?? loadedLanguages),
    [languages, loadedLanguages]
  );
  const options = useMemo(
    () =>
      availableLanguages.map((option) => ({
        label: optionLabel(option),
        value: option.value,
      })),
    [availableLanguages]
  );
  const selectedValue =
    value ??
    selectedOverride ??
    selectedOptionValue(availableLanguages, i18n.language);

  useEffect(() => {
    if (languages) {
      return;
    }
    let cancelled = false;
    setLoading(true);
    getAvailableLocales()
      .then((nextLanguages) => {
        if (!cancelled) {
          setLoadedLanguages(nextLanguages);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          onError?.(error);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [languages, onError]);

  async function handleChange(nextValue: string) {
    const option = availableLanguages.find((item) => item.value === nextValue);
    if (!option || nextValue === selectedValue) {
      return;
    }
    const previousValue = selectedValue;
    setSelectedOverride(nextValue);
    setChanging(true);
    const providerPluginId = option.builtIn ? null : option.pluginId;
    try {
      if (onLanguageChange) {
        await onLanguageChange(option.locale, providerPluginId);
      } else {
        // A null result is a successful built-in fallback when the main
        // process is unavailable. Only a rejected action should roll back the
        // optimistic selection below.
        await setAppLocale(option.locale, i18n, providerPluginId);
      }
    } catch (error) {
      setSelectedOverride(previousValue);
      onError?.(error);
    } finally {
      setChanging(false);
    }
  }

  return (
    <FilterDropdown
      ariaLabel={t("settingsLanguage")}
      className={cn("w-[200px] max-w-full", className)}
      disabled={disabled || loading || changing}
      onChange={(nextValue) => {
        handleChange(nextValue).catch(() => undefined);
      }}
      options={options}
      placeholder={t("settingsLanguage")}
      showSelectedCheck
      value={selectedValue}
    />
  );
}
