import { Save, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { ExifFilters } from "@/types/search";

interface FilterPreset {
  createdAt: number;
  filters: ExifFilters;
  name: string;
}

interface FilterPresetsProps {
  currentFilters: ExifFilters;
  onLoadPreset: (filters: ExifFilters) => void;
}

const STORAGE_KEY = "exif-filter-presets";

function loadPresets(): FilterPreset[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function savePresets(presets: FilterPreset[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
  } catch {
    /* ignore */
  }
}

export function FilterPresets({
  currentFilters,
  onLoadPreset,
}: FilterPresetsProps) {
  const { t } = useTranslation();
  const [presets, setPresets] = useState<FilterPreset[]>([]);
  const [presetName, setPresetName] = useState("");
  const [showSave, setShowSave] = useState(false);
  const [showLoad, setShowLoad] = useState(false);
  const [deleteConfirmName, setDeleteConfirmName] = useState<string | null>(
    null
  );

  useEffect(() => {
    setPresets(loadPresets());
  }, []);

  function handleSave() {
    if (!presetName.trim()) {
      return;
    }
    const newPreset: FilterPreset = {
      name: presetName.trim(),
      filters: { ...currentFilters },
      createdAt: Date.now(),
    };
    const updated = [
      newPreset,
      ...presets.filter((p) => p.name !== presetName.trim()),
    ];
    setPresets(updated);
    savePresets(updated);
    setPresetName("");
    setShowSave(false);
  }

  function handleDelete(name: string) {
    setDeleteConfirmName(name);
  }

  function confirmDelete() {
    if (!deleteConfirmName) {
      return;
    }
    const updated = presets.filter((p) => p.name !== deleteConfirmName);
    setPresets(updated);
    savePresets(updated);
    setDeleteConfirmName(null);
  }

  const hasActiveFilters = Object.values(currentFilters).some(
    (v) => v && v.length > 0
  );

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
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
              {t("filterSavePreset")}
            </button>
          </PopoverTrigger>
          {showSave && (
            <PopoverContent
              align="start"
              className="max-h-[min(12rem,var(--radix-popover-content-available-height))] w-[min(20rem,calc(100vw-1rem))] gap-0 overflow-y-auto overscroll-contain rounded-[6px] border border-border bg-popover p-2 shadow-lg ring-1 ring-foreground/5"
              collisionPadding={8}
              side="top"
              sideOffset={4}
            >
              <div className="flex flex-wrap items-center gap-1.5">
                <input
                  className="h-7 min-w-0 flex-[1_1_9rem] rounded-[4px] border border-border bg-card px-2 text-[12px] text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-primary/40"
                  onChange={(e) => setPresetName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      handleSave();
                    }
                  }}
                  placeholder={t("filterPresetNamePlaceholder")}
                  value={presetName}
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

      {/* Load preset button */}
      {presets.length > 0 && (
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
              {t("filterLoadPresets", { count: presets.length })}
            </button>
          </PopoverTrigger>
          {showLoad && (
            <PopoverContent
              align="end"
              className="max-h-[min(16rem,var(--radix-popover-content-available-height))] w-[min(18rem,calc(100vw-1rem))] gap-0 overflow-y-auto overscroll-contain rounded-[6px] border border-border bg-popover p-1.5 shadow-lg ring-1 ring-foreground/5"
              collisionPadding={8}
              side="top"
              sideOffset={4}
            >
              {presets.map((preset) => (
                <div
                  className="flex min-w-0 items-center justify-between rounded-[4px] px-2 py-1 hover:bg-foreground/5"
                  key={preset.name}
                >
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        className="min-w-0 flex-1 truncate text-left text-[12px] text-foreground"
                        onClick={() => {
                          onLoadPreset(preset.filters);
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
                        aria-label={t("delete")}
                        className="ml-1 shrink-0 text-muted-foreground/70 hover:text-destructive"
                        onClick={() => handleDelete(preset.name)}
                        type="button"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>{t("delete")}</TooltipContent>
                  </Tooltip>
                </div>
              ))}
            </PopoverContent>
          )}
        </Popover>
      )}

      <ConfirmDialog
        confirmText={t("delete")}
        description={t("filterDeletePresetDesc", {
          name: deleteConfirmName ?? "",
        })}
        destructive
        onCancel={() => setDeleteConfirmName(null)}
        onConfirm={confirmDelete}
        open={deleteConfirmName !== null}
        title={t("filterDeletePresetTitle")}
      />
    </div>
  );
}
