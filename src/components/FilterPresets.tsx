import { Save, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ConfirmDialog } from "@/components/ConfirmDialog";
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
    <div className="flex items-center gap-2">
      {/* Save preset button */}
      {hasActiveFilters && (
        <div className="relative">
          <button
            className="flex items-center gap-1 rounded-[4px] px-2 py-1 text-[11px] text-muted-foreground/70 hover:text-foreground"
            onClick={() => {
              setShowSave(!showSave);
              setShowLoad(false);
            }}
            type="button"
          >
            <Save className="h-3 w-3" />
            {t("filterSavePreset")}
          </button>
          {showSave && (
            <div className="absolute bottom-full left-0 z-50 mb-1 rounded-[6px] border border-border bg-popover p-2 shadow-lg ring-1 ring-foreground/5">
              <div className="flex items-center gap-1.5">
                <input
                  className="h-7 w-32 rounded-[4px] border border-border bg-card px-2 text-[12px] text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-primary/40"
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
            </div>
          )}
        </div>
      )}

      {/* Load preset button */}
      {presets.length > 0 && (
        <div className="relative">
          <button
            className="rounded-[4px] px-2 py-1 text-[11px] text-muted-foreground/70 hover:text-foreground"
            onClick={() => {
              setShowLoad(!showLoad);
              setShowSave(false);
            }}
            type="button"
          >
            {t("filterLoadPresets", { count: presets.length })}
          </button>
          {showLoad && (
            <div className="absolute right-0 bottom-full z-50 mb-1 min-w-[180px] rounded-[6px] border border-border bg-popover p-1.5 shadow-lg ring-1 ring-foreground/5">
              {presets.map((preset) => (
                <div
                  className="flex items-center justify-between rounded-[4px] px-2 py-1 hover:bg-foreground/5"
                  key={preset.name}
                >
                  <button
                    className="flex-1 truncate text-left text-[12px] text-foreground"
                    onClick={() => {
                      onLoadPreset(preset.filters);
                      setShowLoad(false);
                    }}
                    type="button"
                  >
                    {preset.name}
                  </button>
                  <button
                    className="ml-1 text-muted-foreground/70 hover:text-destructive"
                    onClick={() => handleDelete(preset.name)}
                    type="button"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
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
