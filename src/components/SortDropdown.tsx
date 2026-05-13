import { useCallback, useEffect, useRef, useState } from "react";
import type { SortField, SortOrder } from "./PhotoGrid";

interface SortDropdownProps {
  onChange: (sort: SortField, order: SortOrder) => void;
  order: SortOrder;
  sort: SortField;
}

const SORT_OPTIONS: { field: SortField; label: string; order: SortOrder }[] = [
  { field: "date", label: "日期 新→旧", order: "desc" },
  { field: "date", label: "日期 旧→新", order: "asc" },
  { field: "name", label: "文件名 A→Z", order: "asc" },
  { field: "name", label: "文件名 Z→A", order: "desc" },
  { field: "size", label: "大小 大→小", order: "desc" },
  { field: "size", label: "大小 小→大", order: "asc" },
];

export function SortDropdown({ sort, order, onChange }: SortDropdownProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const current = SORT_OPTIONS.find(
    (o) => o.field === sort && o.order === order,
  ) ?? SORT_OPTIONS[0];

  const handleSelect = useCallback(
    (opt: (typeof SORT_OPTIONS)[number]) => {
      onChange(opt.field, opt.order);
      setOpen(false);
    },
    [onChange],
  );

  useEffect(() => {
    if (!open) return;
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
        <svg className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
          <path d="M3 6h18M6 12h12M9 18h6" strokeLinecap="round" />
        </svg>
        {current.label}
      </button>
      {open && (
        <div className="absolute top-full right-0 z-50 mt-1 min-w-[140px] rounded-[6px] border border-border bg-[#1c1e22] py-1 shadow-lg">
          {SORT_OPTIONS.map((opt) => (
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
