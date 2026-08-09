import { useTranslation } from "react-i18next";
import { FilterDropdown } from "./filter-dropdown";
import type { SortField, SortOrder } from "./PhotoGrid";

interface SortDropdownProps {
  onChange: (sort: SortField, order: SortOrder) => void;
  order: SortOrder;
  sort: SortField;
}

const SORT_OPTION_KEYS: {
  field: SortField;
  labelKey: string;
  order: SortOrder;
}[] = [
  { field: "date", labelKey: "sortDateDesc", order: "desc" },
  { field: "date", labelKey: "sortDateAsc", order: "asc" },
  { field: "name", labelKey: "sortNameAsc", order: "asc" },
  { field: "name", labelKey: "sortNameDesc", order: "desc" },
  { field: "size", labelKey: "sortSizeDesc", order: "desc" },
  { field: "size", labelKey: "sortSizeAsc", order: "asc" },
];

export function SortDropdown({ sort, order, onChange }: SortDropdownProps) {
  const { t } = useTranslation();
  const options = SORT_OPTION_KEYS.map((option) => ({
    label: t(option.labelKey),
    value: `${option.field}:${option.order}`,
  }));
  const currentValue = `${sort}:${order}`;
  const value = options.some((option) => option.value === currentValue)
    ? currentValue
    : options[0].value;

  return (
    <FilterDropdown
      ariaLabel={t("sortBy")}
      className="w-[min(140px,100%)] min-w-0 max-w-full"
      onChange={(selectedValue) => {
        const selectedOption = SORT_OPTION_KEYS.find(
          (option) => `${option.field}:${option.order}` === selectedValue
        );
        if (selectedOption) {
          onChange(selectedOption.field, selectedOption.order);
        }
      }}
      options={options}
      placeholder={t("sortBy")}
      value={value}
    />
  );
}
