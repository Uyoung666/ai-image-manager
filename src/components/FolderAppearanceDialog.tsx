/** biome-ignore-all lint/style/useFilenamingConvention: React component files use the project's PascalCase convention. */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  FOLDER_APPEARANCE_COLORS,
  FOLDER_APPEARANCE_ICONS,
  type FolderAppearanceIcon,
  HEX_COLOR_PATTERN,
} from "@/lib/folder-appearance";
import type { Folder as FolderType } from "@/types/photo";
import { FolderBadge } from "./FolderBadge";

interface FolderAppearanceDialogProps {
  folder: FolderType | null;
  onOpenChange: (open: boolean) => void;
  onSave: (appearance: {
    color: string | null;
    icon: FolderAppearanceIcon | null;
  }) => Promise<void>;
}

export function FolderAppearanceDialog({
  folder,
  onOpenChange,
  onSave,
}: FolderAppearanceDialogProps) {
  const { t } = useTranslation();
  const [color, setColor] = useState<string | null>(null);
  const [icon, setIcon] = useState<FolderAppearanceIcon | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setColor(folder?.appearanceColor ?? null);
    setIcon(folder?.appearanceIcon ?? null);
  }, [folder]);

  const colorIsValid = color === null || HEX_COLOR_PATTERN.test(color);
  const previewFolder = folder
    ? {
        ...folder,
        appearanceColor: colorIsValid ? color : null,
        appearanceIcon: icon,
      }
    : null;

  async function handleSave() {
    if (!colorIsValid) {
      return;
    }
    setSaving(true);
    try {
      await onSave({ color, icon });
    } catch {
      // The parent reports the error and keeps the dialog open for retry.
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={folder !== null}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("folderAppearanceTitle")}</DialogTitle>
          <DialogDescription>
            {t("folderAppearanceDescription")}
          </DialogDescription>
        </DialogHeader>

        {previewFolder && (
          <div className="flex items-center gap-3 rounded-[8px] border border-border bg-foreground/[0.025] p-3">
            <FolderBadge className="h-9 w-9 text-sm" folder={previewFolder} />
            <div className="min-w-0">
              <p className="truncate font-medium text-sm">
                {previewFolder.displayName}
              </p>
              <p className="text-[11px] text-muted-foreground">
                {t("folderAppearancePreview")}
              </p>
            </div>
          </div>
        )}

        <div className="space-y-2">
          <p className="font-medium text-xs">{t("folderAppearanceIcon")}</p>
          <div className="grid grid-cols-7 gap-1.5">
            <button
              aria-label={t("folderAppearanceInitial")}
              aria-pressed={icon === null}
              className={`flex h-9 items-center justify-center rounded-[6px] border text-xs transition-colors ${icon === null ? "border-primary bg-primary/10 text-primary" : "border-border hover:bg-foreground/5"}`}
              onClick={() => setIcon(null)}
              type="button"
            >
              Aa
            </button>
            {FOLDER_APPEARANCE_ICONS.map((appearanceIcon) => (
              <button
                aria-label={t("folderAppearanceIconOption", {
                  icon: appearanceIcon,
                })}
                aria-pressed={icon === appearanceIcon}
                className={`flex h-9 items-center justify-center rounded-[6px] border transition-colors ${icon === appearanceIcon ? "border-primary bg-primary/10" : "border-border hover:bg-foreground/5"}`}
                key={appearanceIcon}
                onClick={() => setIcon(appearanceIcon)}
                type="button"
              >
                {folder && (
                  <FolderBadge
                    className="h-6 w-6"
                    folder={{
                      ...folder,
                      appearanceColor: colorIsValid ? color : null,
                      appearanceIcon,
                    }}
                  />
                )}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-2">
          <p className="font-medium text-xs">{t("folderAppearanceColor")}</p>
          <div className="flex flex-wrap gap-2">
            {FOLDER_APPEARANCE_COLORS.map((appearanceColor) => (
              <button
                aria-label={appearanceColor}
                aria-pressed={color === appearanceColor}
                className={`h-7 w-7 rounded-full border-2 transition-transform hover:scale-105 ${color === appearanceColor ? "border-foreground" : "border-transparent"}`}
                key={appearanceColor}
                onClick={() => setColor(appearanceColor)}
                style={{ backgroundColor: appearanceColor }}
                type="button"
              />
            ))}
          </div>
          <div className="flex items-center gap-2">
            <input
              aria-label={t("folderAppearanceColor")}
              className="h-8 w-10 cursor-pointer rounded border border-border bg-transparent p-1"
              onChange={(event) => setColor(event.target.value.toUpperCase())}
              type="color"
              value={
                colorIsValid && color ? color : FOLDER_APPEARANCE_COLORS[0]
              }
            />
            <input
              className="h-8 flex-1 rounded-[6px] border border-border bg-background px-2 font-mono text-xs outline-none focus:border-primary"
              onChange={(event) => setColor(event.target.value.toUpperCase())}
              placeholder="#5E6AD2"
              value={color ?? ""}
            />
          </div>
          {!colorIsValid && (
            <p className="text-[11px] text-destructive">
              {t("folderAppearanceInvalidColor")}
            </p>
          )}
        </div>

        <DialogFooter className="sm:justify-between">
          <button
            className="rounded-[6px] px-3 py-1.5 text-muted-foreground text-xs hover:bg-foreground/5 hover:text-foreground"
            onClick={() => {
              setColor(null);
              setIcon(null);
            }}
            type="button"
          >
            {t("folderAppearanceReset")}
          </button>
          <div className="flex gap-2">
            <button
              className="rounded-[6px] border border-border px-3 py-1.5 text-xs hover:bg-foreground/5"
              onClick={() => onOpenChange(false)}
              type="button"
            >
              {t("cancel")}
            </button>
            <button
              className="rounded-[6px] bg-primary px-3 py-1.5 font-medium text-primary-foreground text-xs disabled:opacity-50"
              disabled={!colorIsValid || saving}
              onClick={handleSave}
              type="button"
            >
              {saving ? t("saving") : t("save")}
            </button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
