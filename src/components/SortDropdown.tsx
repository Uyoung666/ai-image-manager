import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
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
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const options = SORT_OPTION_KEYS.map((option) => ({
    ...option,
    label: t(option.labelKey),
  }));
  const current =
    options.find((o) => o.field === sort && o.order === order) ?? options[0];

  function handleSelect(opt: (typeof SORT_OPTION_KEYS)[number]) {
    onChange(opt.field, opt.order);
    setOpen(false);
  }

  useEffect(() => {
    if (!open) {
      return;
    }
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        className="flex items-center gap-1 rounded-[4px] px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
        onClick={() => setOpen((v) => !v)}
      >
        <svg
          className="h-3 w-3"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          viewBox="0 0 24 24"
        >
          <path d="M3 6h18M6 12h12M9 18h6" strokeLinecap="round" />
        </svg>
        {current.label}
      </button>
      {open && (
        <div className="absolute top-full right-0 z-50 mt-1 min-w-[140px] rounded-[6px] border border-border bg-popover py-1 shadow-lg">
          {options.map((opt) => (
            <button
              className={`w-full px-3 py-1.5 text-left text-[11px] transition-colors hover:bg-foreground/5 ${
                opt.field === sort && opt.order === order
                  ? "text-primary"
                  : "text-foreground"
              }`}
              key={`${opt.field}-${opt.order}`}
              onClick={() => handleSelect(opt)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
