import { Save, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  type SearchPreset as FilterPreset,
  readSearchPresets as loadPresets,
  markSearchPresetUsed,
  SEARCH_PRESETS_CHANGED,
  type SearchPresetContext,
  writeSearchPresets as savePresets,
} from "@/actions/search-presets";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { SmoothInput } from "@/components/ui/smooth-input";
import {
  Tooltip,
  TooltipContent,
  TooltipPortalProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { ExifFilters } from "@/types/search";
import { cn } from "@/utils/tailwind";

interface DeletedPresetSnapshot {
  index: number;
  order: string[];
  preset: FilterPreset;
}

interface FilterPresetsProps {
  currentFilters: ExifFilters;
  currentSearch?: SearchPresetContext;
  onLoadPreset: (filters: ExifFilters) => void;
  onLoadSearchPreset?: (preset: FilterPreset) => void;
  presentation?: "inline" | "popover";
}

function insertByOrder(
  current: string[],
  name: string,
  order: string[]
): string[] {
  if (current.includes(name)) {
    return [...current];
  }

  const orderIndex = order.indexOf(name);
  if (orderIndex < 0) {
    return [...current, name];
  }

  for (let index = orderIndex + 1; index < order.length; index++) {
    const nextIndex = current.indexOf(order[index] ?? "");
    if (nextIndex >= 0) {
      const restored = [...current];
      restored.splice(nextIndex, 0, name);
      return restored;
    }
  }

  for (let index = orderIndex - 1; index >= 0; index--) {
    const previousIndex = current.indexOf(order[index] ?? "");
    if (previousIndex >= 0) {
      const restored = [...current];
      restored.splice(previousIndex + 1, 0, name);
      return restored;
    }
  }

  const restored = [...current];
  restored.splice(Math.min(orderIndex, restored.length), 0, name);
  return restored;
}

function getDeleteOrder(
  latest: FilterPreset[],
  snapshots: Iterable<DeletedPresetSnapshot>
): string[] {
  let order = latest.map((preset) => preset.name);
  for (const snapshot of snapshots) {
    order = insertByOrder(order, snapshot.preset.name, snapshot.order);
  }
  return order;
}

function restorePreset(
  current: FilterPreset[],
  snapshot: DeletedPresetSnapshot
): FilterPreset[] {
  const names = insertByOrder(
    current.map((preset) => preset.name),
    snapshot.preset.name,
    snapshot.order
  );
  const insertionIndex = names.indexOf(snapshot.preset.name);
  const restored = [...current];
  restored.splice(
    insertionIndex >= 0
      ? insertionIndex
      : Math.min(snapshot.index, restored.length),
    0,
    snapshot.preset
  );
  return restored;
}

export function FilterPresets({
  currentFilters,
  currentSearch,
  onLoadSearchPreset,
  onLoadPreset,
  presentation = "popover",
}: FilterPresetsProps) {
  const { t } = useTranslation();
  const [presets, setPresets] = useState<FilterPreset[]>([]);
  const [presetName, setPresetName] = useState("");
  const [showSave, setShowSave] = useState(false);
  const [showLoad, setShowLoad] = useState(false);
  const inlineTooltipRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLElement>(null);
  const [stripFade, setStripFade] = useState({ left: false, right: false });
  const presetNameComposingRef = useRef(false);
  const deletedSnapshotsRef = useRef<Map<string, DeletedPresetSnapshot>>(
    new Map()
  );

  useEffect(() => {
    const refresh = () => setPresets(loadPresets());
    refresh();
    window.addEventListener(SEARCH_PRESETS_CHANGED, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(SEARCH_PRESETS_CHANGED, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  const updateStripFade = useCallback(() => {
    const strip = stripRef.current;
    if (!strip) {
      return;
    }
    const left = strip.scrollLeft > 2;
    const right = strip.scrollWidth - strip.scrollLeft - strip.clientWidth > 2;
    setStripFade((previous) =>
      previous.left === left && previous.right === right
        ? previous
        : { left, right }
    );
  }, []);

  useEffect(() => {
    const strip = stripRef.current;
    if (presentation !== "inline" || presets.length === 0 || !strip) {
      return;
    }
    updateStripFade();
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(updateStripFade);
    observer.observe(strip);
    return () => observer.disconnect();
  }, [presentation, presets, updateStripFade]);

  function handleSave() {
    if (!presetName.trim()) {
      return;
    }
    const newPreset: FilterPreset = {
      name: presetName.trim(),
      filters: { ...currentFilters },
      createdAt: Date.now(),
      ...(currentSearch ? { search: { ...currentSearch } } : {}),
    };
    const updated = [
      newPreset,
      ...loadPresets().filter((p) => p.name !== presetName.trim()),
    ];
    if (!savePresets(updated)) {
      toast.error(t("searchPresetSaveFailed"));
      return;
    }
    setPresets(updated);
    setPresetName("");
    setShowSave(false);
  }

  function handleDelete(name: string) {
    const latest = loadPresets();
    const deletedIndex = latest.findIndex((preset) => preset.name === name);
    if (deletedIndex < 0) {
      setPresets(latest);
      return;
    }

    const deleted = latest[deletedIndex];
    if (!deleted) {
      setPresets(latest);
      return;
    }
    const order = getDeleteOrder(latest, deletedSnapshotsRef.current.values());
    const snapshot: DeletedPresetSnapshot = {
      index: order.indexOf(deleted.name),
      order,
      preset: deleted,
    };
    deletedSnapshotsRef.current.set(deleted.name, snapshot);
    const updated = latest.filter((_, index) => index !== deletedIndex);
    setPresets(updated);
    savePresets(updated);

    let undone = false;
    toast.success(t("filterPresetDeleted", { name: deleted.name }), {
      action: {
        label: t("toastUndo"),
        onClick: () => {
          if (undone) {
            return;
          }
          undone = true;

          const current = loadPresets();
          if (current.some((preset) => preset.name === snapshot.preset.name)) {
            deletedSnapshotsRef.current.delete(snapshot.preset.name);
            setPresets(current);
            toast.error(
              t("filterPresetUndoConflict", { name: snapshot.preset.name })
            );
            return;
          }

          const restored = restorePreset(current, snapshot);
          deletedSnapshotsRef.current.delete(snapshot.preset.name);
          setPresets(restored);
          savePresets(restored);
          toast.success(
            t("filterPresetRestored", { name: snapshot.preset.name })
          );
        },
      },
      duration: 8000,
    });
  }

  const hasActiveFilters =
    !!(currentSearch?.query.trim() || currentSearch?.colorHex) ||
    Object.values(currentFilters).some((v) => v && v.length > 0);
  const inline = presentation === "inline";
  const sortedPresets = [...presets].sort(
    (a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0)
  );
  const presetItems = sortedPresets.map((preset) => (
    <div
      className={cn(
        "flex min-w-0 items-center justify-between rounded-[4px] hover:bg-foreground/5",
        inline
          ? "max-w-[min(14rem,70vw)] shrink-0 border border-border bg-secondary/40 pr-1"
          : "px-2 py-1"
      )}
      key={preset.name}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            className={cn(
              "min-w-0 flex-1 truncate text-left text-[12px] text-foreground",
              inline && "px-2.5 py-1.5"
            )}
            data-search-preset={preset.name}
            onClick={() => {
              if (onLoadSearchPreset) {
                onLoadSearchPreset(preset);
              } else {
                onLoadPreset(preset.filters);
              }
              markSearchPresetUsed(preset.name);
              setShowLoad(false);
            }}
            type="button"
          >
            {preset.name}
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-[min(28rem,calc(100vw-1rem))] break-all">
          {preset.name}
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            aria-label={inline ? `${t("delete")} ${preset.name}` : t("delete")}
            className={cn(
              "ml-1 shrink-0 text-muted-foreground/70 hover:text-destructive",
              inline && "rounded-[3px] p-1.5"
            )}
            onClick={() => handleDelete(preset.name)}
            type="button"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </TooltipTrigger>
        <TooltipContent>
          {inline ? `${t("delete")} ${preset.name}` : t("delete")}
        </TooltipContent>
      </Tooltip>
    </div>
  ));

  return (
    <div
      className={cn(
        "flex min-w-0 gap-2",
        inline ? "w-full max-w-full flex-col" : "flex-wrap items-center"
      )}
      ref={inlineTooltipRef}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {inline && (
          <div className="mr-auto flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-[11px] text-muted-foreground">
              {t("searchLoadPresets", { count: presets.length })}
            </span>
          </div>
        )}
        {/* Save preset button */}
        {hasActiveFilters && (
          <Popover
            onOpenChange={(nextOpen) => {
              setShowSave(nextOpen);
              if (nextOpen) {
                setShowLoad(false);
              }
            }}
            open={showSave}
          >
            <PopoverTrigger asChild>
              <button
                className="flex items-center gap-1 rounded-[4px] px-2 py-1 text-[11px] text-muted-foreground/70 hover:text-foreground"
                type="button"
              >
                <Save className="h-3 w-3" />
                {t(currentSearch ? "searchSavePreset" : "filterSavePreset")}
              </button>
            </PopoverTrigger>
            {showSave && (
              <PopoverContent
                align="start"
                className="max-h-[min(12rem,var(--radix-popover-content-available-height))] w-[min(20rem,calc(100vw-1rem))] gap-0 overflow-y-auto overscroll-contain rounded-[6px] border border-border bg-popover p-2 shadow-lg ring-1 ring-foreground/5"
                collisionPadding={8}
                data-overlay-kind="filter-presets"
                data-surface="overlay"
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.stopPropagation();
                  }
                }}
                side="top"
                sideOffset={4}
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  <SmoothInput
                    className="h-7 rounded-[4px] border border-border bg-card px-2 text-[12px] text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-primary/40"
                    onChange={(e) => setPresetName(e.target.value)}
                    onCompositionEnd={() => {
                      presetNameComposingRef.current = false;
                    }}
                    onCompositionStart={() => {
                      presetNameComposingRef.current = true;
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.stopPropagation();
                        if (
                          e.nativeEvent.isComposing ||
                          e.nativeEvent.keyCode === 229 ||
                          presetNameComposingRef.current
                        ) {
                          return;
                        }
                        e.preventDefault();
                        handleSave();
                      }
                    }}
                    placeholder={t("filterPresetNamePlaceholder")}
                    value={presetName}
                    wrapperClassName="min-w-0 flex-[1_1_9rem]"
                  />
                  <button
                    className="rounded-[4px] bg-primary/10 px-2 py-1 text-[11px] text-primary hover:bg-primary/20"
                    onClick={handleSave}
                    type="button"
                  >
                    {t("save")}
                  </button>
                </div>
              </PopoverContent>
            )}
          </Popover>
        )}
      </div>

      {inline &&
        (presets.length ? (
          <section
            aria-label={t("searchLoadPresets", { count: presets.length })}
            className="search-preset-strip flex w-full min-w-0 items-center gap-1.5 overflow-x-auto overscroll-x-contain py-1"
            data-left-fade={stripFade.left}
            data-right-fade={stripFade.right}
            data-search-preset-strip
            onScroll={updateStripFade}
            ref={stripRef}
          >
            <TooltipPortalProvider containerRef={inlineTooltipRef}>
              {presetItems}
            </TooltipPortalProvider>
          </section>
        ) : (
          <p className="text-[12px] text-muted-foreground">
            {t("searchPresetsEmpty")}
          </p>
        ))}

      {/* Load preset button */}
      {!inline && (presets.length > 0 || currentSearch) && (
        <Popover
          onOpenChange={(nextOpen) => {
            setShowLoad(nextOpen);
            if (nextOpen) {
              setShowSave(false);
            }
          }}
          open={showLoad}
        >
          <PopoverTrigger asChild>
            <button
              className="rounded-[4px] px-2 py-1 text-[11px] text-muted-foreground/70 hover:text-foreground"
              type="button"
            >
              {t(currentSearch ? "searchLoadPresets" : "filterLoadPresets", {
                count: presets.length,
              })}
            </button>
          </PopoverTrigger>
          {showLoad && (
            <PopoverContent
              align="end"
              className="max-h-[min(16rem,var(--radix-popover-content-available-height))] w-[min(18rem,calc(100vw-1rem))] gap-0 overflow-y-auto overscroll-contain rounded-[6px] border border-border bg-popover p-1.5 shadow-lg ring-1 ring-foreground/5"
              collisionPadding={8}
              data-overlay-kind="filter-presets"
              data-surface="overlay"
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.stopPropagation();
                }
              }}
              side="top"
              sideOffset={4}
            >
              {presets.length === 0 && (
                <p className="p-2 text-[12px] text-muted-foreground">
                  {t("searchPresetsEmpty")}
                </p>
              )}
              {presetItems}
            </PopoverContent>
          )}
        </Popover>
      )}
    </div>
  );
}
