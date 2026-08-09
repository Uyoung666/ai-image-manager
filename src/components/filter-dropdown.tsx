import { Check, ChevronDown } from "lucide-react";
import {
  type KeyboardEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";
import { cn } from "@/utils/tailwind";

export interface FilterDropdownOption {
  color?: string;
  label: string;
  value: string;
}

export const FILTER_DROPDOWN_CLASS_NAME =
  "h-8 rounded-[4px] border border-border bg-card px-2 text-[12px] text-foreground outline-none focus:border-primary/40";

const FILTER_DROPDOWN_CLASS_SPLIT_PATTERN = /\s+/;
const FILTER_DROPDOWN_WIDTH_TOKEN_PATTERN =
  /^(?:[a-z-]+:)*(?:w-|min-w-|max-w-)/;

function getAnchorWidthClasses(className?: string) {
  return className
    ?.split(FILTER_DROPDOWN_CLASS_SPLIT_PATTERN)
    .filter((token) => FILTER_DROPDOWN_WIDTH_TOKEN_PATTERN.test(token));
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
  showOptionColors = false,
  showSelectedCheck = false,
  value,
  wrapperClassName,
}: {
  ariaLabel?: string;
  className?: string;
  disabled?: boolean;
  editable?: boolean;
  id?: string;
  onChange: (value: string) => void;
  options: FilterDropdownOption[];
  placeholder: string;
  showOptionColors?: boolean;
  showSelectedCheck?: boolean;
  value: string;
  wrapperClassName?: string;
}) {
  const inputId = useId();
  const listboxId = `${inputId}-listbox`;
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [contentWidth, setContentWidth] = useState<number>();
  const anchorRef = useRef<HTMLDivElement>(null);
  const pointerDownStateRef = useRef<{
    wasFocused: boolean;
    wasOpen: boolean;
  } | null>(null);
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
  const selectedOption = options.find((option) => option.value === value);
  const selectedIndex = visibleOptions.findIndex(
    (option) => option.value === value
  );
  const anchorWidthClasses = getAnchorWidthClasses(className);

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

  useLayoutEffect(() => {
    if (!open) {
      return;
    }

    const anchor = anchorRef.current;
    if (!anchor) {
      return;
    }

    const updateWidth = () => {
      const nextWidth = anchor.getBoundingClientRect().width;
      setContentWidth(nextWidth > 0 ? nextWidth : undefined);
    };
    updateWidth();

    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(updateWidth);
    observer.observe(anchor);
    return () => observer.disconnect();
  }, [open]);

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
    <Popover
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          setOpen(false);
          setActiveIndex(-1);
        }
      }}
      open={open}
    >
      <PopoverAnchor asChild>
        <div
          className={cn(
            "relative min-w-0 max-w-full",
            wrapperClassName,
            !wrapperClassName &&
              (anchorWidthClasses?.length ? anchorWidthClasses : "w-fit")
          )}
          ref={anchorRef}
        >
          {showOptionColors && selectedOption?.color && (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-2 z-10 h-2.5 w-2.5 -translate-y-1/2 rounded-full"
              style={{ backgroundColor: selectedOption.color }}
            />
          )}
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
              showOptionColors && selectedOption?.color && "pl-7",
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
            onClick={() => {
              const pointerDownState = pointerDownStateRef.current;
              pointerDownStateRef.current = null;

              // A real click focuses the input before firing click. In that case
              // focus already opened a closed dropdown, so the first click should
              // remain open; subsequent clicks toggle it normally.
              if (
                pointerDownState &&
                !pointerDownState.wasOpen &&
                !pointerDownState.wasFocused
              ) {
                return;
              }

              if (pointerDownState) {
                setOpen(!pointerDownState.wasOpen);
                return;
              }

              setOpen((previous) => !previous);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={handleKeyDown}
            onMouseDown={(event) => {
              if (event.button !== 0) {
                return;
              }
              pointerDownStateRef.current = {
                wasFocused: document.activeElement === event.currentTarget,
                wasOpen: open,
              };
            }}
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
        </div>
      </PopoverAnchor>
      {open && visibleOptions.length > 0 && (
        <PopoverContent
          align="start"
          className="z-[60] max-h-[min(12rem,var(--radix-popover-content-available-height))] min-w-[8rem] max-w-[calc(100vw-1rem)] gap-0 overflow-y-auto overflow-x-hidden overscroll-contain rounded-[6px] border border-border bg-popover p-0 shadow-lg ring-1 ring-foreground/5"
          collisionPadding={8}
          id={listboxId}
          onCloseAutoFocus={(event) => event.preventDefault()}
          onInteractOutside={(event) => {
            if (
              event.target instanceof Node &&
              anchorRef.current?.contains(event.target)
            ) {
              event.preventDefault();
            }
          }}
          onOpenAutoFocus={(event) => event.preventDefault()}
          onPointerDown={(event) => event.stopPropagation()}
          role="listbox"
          sideOffset={4}
          style={contentWidth ? { width: contentWidth } : undefined}
        >
          {visibleOptions.map((option, index) => (
            <button
              aria-selected={option.value === value}
              className={cn(
                "flex w-full items-center justify-between truncate px-2.5 py-1.5 text-left text-[12px] text-foreground hover:bg-foreground/5",
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
              <span className="flex min-w-0 items-center gap-2 truncate">
                {showOptionColors && option.color && (
                  <span
                    aria-hidden="true"
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: option.color }}
                  />
                )}
                <span className="truncate">{option.label}</span>
              </span>
              {showSelectedCheck && option.value === value && (
                <Check
                  aria-hidden="true"
                  className="ml-2 h-3.5 w-3.5 shrink-0 text-foreground"
                />
              )}
            </button>
          ))}
        </PopoverContent>
      )}
    </Popover>
  );
}
