import { ChevronDown } from "lucide-react";
import { useMemo, useState } from "react";
import { cn } from "@/utils/tailwind";

export interface FilterDropdownOption {
  label: string;
  value: string;
}

export function FilterDropdown({
  ariaLabel,
  className,
  disabled = false,
  editable = false,
  id,
  onChange,
  options,
  placeholder,
  value,
}: {
  ariaLabel?: string;
  className: string;
  disabled?: boolean;
  editable?: boolean;
  id?: string;
  onChange: (value: string) => void;
  options: FilterDropdownOption[];
  placeholder: string;
  value: string;
}) {
  const [open, setOpen] = useState(false);
  const visibleOptions = useMemo(() => {
    if (!(editable && value.trim())) {
      return options;
    }
    const query = value.toLocaleLowerCase();
    return options.filter((option) =>
      option.label.toLocaleLowerCase().includes(query)
    );
  }, [editable, options, value]);
  const displayValue = editable
    ? value
    : (options.find((option) => option.value === value)?.label ?? "");

  return (
    <div className="relative">
      <input
        aria-autocomplete={editable ? "list" : "none"}
        aria-expanded={open}
        aria-label={ariaLabel}
        autoComplete="off"
        className={cn(
          className,
          !editable && "cursor-pointer pr-7",
          disabled && "cursor-not-allowed opacity-50"
        )}
        disabled={disabled}
        id={id}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={(event) => {
          if (editable) {
            onChange(event.target.value);
          }
          setOpen(true);
        }}
        onClick={() => setOpen(true)}
        onFocus={() => setOpen(true)}
        placeholder={placeholder}
        readOnly={!editable}
        role="combobox"
        value={displayValue}
      />
      {!editable && (
        <ChevronDown
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 right-2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
        />
      )}
      {open && visibleOptions.length > 0 && (
        <div
          className="absolute top-full right-0 left-0 z-[60] mt-1 max-h-48 overflow-y-auto rounded-[6px] border border-border bg-popover shadow-lg ring-1 ring-foreground/5"
          role="listbox"
        >
          {visibleOptions.map((option) => (
            <button
              aria-selected={option.value === value}
              className={cn(
                "flex w-full items-center truncate px-2.5 py-1.5 text-left text-[12px] text-foreground hover:bg-foreground/5",
                option.value === value && "bg-foreground/5"
              )}
              key={option.value || "__empty__"}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
              onMouseDown={(event) => event.preventDefault()}
              role="option"
              type="button"
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
