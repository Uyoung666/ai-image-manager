import { ChevronDown } from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useMemo, useState } from "react";
import { cn } from "@/utils/tailwind";

export interface FilterDropdownOption {
  label: string;
  value: string;
}

export const FILTER_DROPDOWN_CLASS_NAME =
  "h-8 rounded-[4px] border border-border bg-card px-2 text-[12px] text-foreground outline-none focus:border-primary/40";

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
  className?: string;
  disabled?: boolean;
  editable?: boolean;
  id?: string;
  onChange: (value: string) => void;
  options: FilterDropdownOption[];
  placeholder: string;
  value: string;
}) {
  const inputId = useId();
  const listboxId = `${inputId}-listbox`;
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
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
  const selectedIndex = visibleOptions.findIndex(
    (option) => option.value === value
  );

  function getDefaultActiveIndex() {
    if (selectedIndex >= 0) {
      return selectedIndex;
    }
    if (visibleOptions.length > 0) {
      return 0;
    }
    return -1;
  }

  useEffect(() => {
    if (!open) {
      setActiveIndex(-1);
      return;
    }

    setActiveIndex((previous) => {
      if (previous >= 0 && previous < visibleOptions.length) {
        return previous;
      }
      if (selectedIndex >= 0) {
        return selectedIndex;
      }
      return visibleOptions.length > 0 ? 0 : -1;
    });
  }, [open, selectedIndex, visibleOptions.length]);

  function selectOption(option: FilterDropdownOption) {
    onChange(option.value);
    setOpen(false);
    setActiveIndex(-1);
  }

  function handleArrowKey(event: KeyboardEvent<HTMLInputElement>) {
    event.preventDefault();
    if (!open) {
      setOpen(true);
      setActiveIndex(getDefaultActiveIndex());
      return;
    }
    if (visibleOptions.length === 0) {
      return;
    }
    const delta = event.key === "ArrowDown" ? 1 : -1;
    setActiveIndex((previous) => {
      let start = previous;
      if (start < 0) {
        start = getDefaultActiveIndex();
      }
      return (start + delta + visibleOptions.length) % visibleOptions.length;
    });
  }

  function handleActivationKey(event: KeyboardEvent<HTMLInputElement>) {
    if (!open) {
      event.preventDefault();
      setOpen(true);
      setActiveIndex(getDefaultActiveIndex());
      return;
    }
    const activeOption = visibleOptions[activeIndex];
    if (activeOption) {
      event.preventDefault();
      selectOption(activeOption);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (disabled) {
      return;
    }

    if (event.key === "Escape") {
      if (open) {
        event.preventDefault();
        setOpen(false);
      }
      return;
    }

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      handleArrowKey(event);
      return;
    }

    if (!editable && (event.key === "Home" || event.key === "End") && open) {
      event.preventDefault();
      setActiveIndex(event.key === "Home" ? 0 : visibleOptions.length - 1);
      return;
    }

    if (event.key === "Enter" || event.key === " ") {
      handleActivationKey(event);
    }
  }

  return (
    <div className="relative">
      <input
        aria-activedescendant={
          open && activeIndex >= 0
            ? `${inputId}-option-${activeIndex}`
            : undefined
        }
        aria-autocomplete={editable ? "list" : "none"}
        aria-controls={open ? listboxId : undefined}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        autoComplete="off"
        className={cn(
          FILTER_DROPDOWN_CLASS_NAME,
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
        onKeyDown={handleKeyDown}
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
          id={listboxId}
          role="listbox"
        >
          {visibleOptions.map((option, index) => (
            <button
              aria-selected={option.value === value}
              className={cn(
                "flex w-full items-center truncate px-2.5 py-1.5 text-left text-[12px] text-foreground hover:bg-foreground/5",
                option.value === value && "bg-foreground/5",
                index === activeIndex && "bg-foreground/10"
              )}
              id={`${inputId}-option-${index}`}
              key={option.value || "__empty__"}
              onClick={() => {
                selectOption(option);
              }}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActiveIndex(index)}
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
