import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface Shortcut {
  keyLabels: string[];
  labelKey: string;
  sectionKey: string;
}

const SHORTCUTS: Shortcut[] = [
  {
    sectionKey: "shortcutBrowse",
    keyLabels: ["Space"],
    labelKey: "shortcutQuickPreview",
  },
  {
    sectionKey: "shortcutBrowse",
    keyLabels: ["←", "→"],
    labelKey: "shortcutPreviewNavigate",
  },
  {
    sectionKey: "shortcutBrowse",
    keyLabels: ["Esc"],
    labelKey: "shortcutClosePanels",
  },
  {
    sectionKey: "shortcutBrowse",
    keyLabels: ["doubleClick"],
    labelKey: "shortcutOpenLightbox",
  },
  {
    sectionKey: "shortcutSelect",
    keyLabels: ["click"],
    labelKey: "shortcutSelectPhoto",
  },
  {
    sectionKey: "shortcutSelect",
    keyLabels: ["Ctrl", "click"],
    labelKey: "shortcutMultiSelect",
  },
  {
    sectionKey: "shortcutSelect",
    keyLabels: ["Shift", "click"],
    labelKey: "shortcutRangeSelect",
  },
  {
    sectionKey: "shortcutSelect",
    keyLabels: ["Ctrl", "A"],
    labelKey: "shortcutSelectAll",
  },
  {
    sectionKey: "shortcutActions",
    keyLabels: ["Delete"],
    labelKey: "shortcutDeleteSelected",
  },
  {
    sectionKey: "shortcutActions",
    keyLabels: ["F2"],
    labelKey: "shortcutRename",
  },
  {
    sectionKey: "shortcutActions",
    keyLabels: ["Ctrl", "Shift", "E"],
    labelKey: "shortcutExport",
  },
  {
    sectionKey: "shortcutActions",
    keyLabels: ["Ctrl", "Shift", "C"],
    labelKey: "shortcutConvert",
  },
  {
    sectionKey: "shortcutActions",
    keyLabels: ["F"],
    labelKey: "shortcutToggleFavorite",
  },
  {
    sectionKey: "shortcutActions",
    keyLabels: ["I"],
    labelKey: "shortcutToggleDetail",
  },
  {
    sectionKey: "shortcutActions",
    keyLabels: ["rightClick"],
    labelKey: "shortcutContextMenu",
  },
  {
    sectionKey: "shortcutInterface",
    keyLabels: ["["],
    labelKey: "shortcutToggleSidebar",
  },
  {
    sectionKey: "shortcutInterface",
    keyLabels: ["Ctrl", "K"],
    labelKey: "shortcutGlobalSearch",
  },
  {
    sectionKey: "shortcutInterface",
    keyLabels: ["?"],
    labelKey: "shortcutHelp",
  },
  {
    sectionKey: "shortcutInterface",
    keyLabels: ["Ctrl", "Shift", "F"],
    labelKey: "shortcutGlobalFocusSearch",
  },
  {
    sectionKey: "shortcutInterface",
    keyLabels: ["Ctrl", "Shift", "H"],
    labelKey: "shortcutGlobalHideWindow",
  },
  {
    sectionKey: "shortcutLightbox",
    keyLabels: ["←", "→"],
    labelKey: "shortcutLightboxNavigate",
  },
  {
    sectionKey: "shortcutLightbox",
    keyLabels: ["Space"],
    labelKey: "shortcutSlideshow",
  },
  {
    sectionKey: "shortcutLightbox",
    keyLabels: ["I"],
    labelKey: "shortcutLightboxInfo",
  },
  {
    sectionKey: "shortcutLightbox",
    keyLabels: ["F"],
    labelKey: "shortcutToggleFavorite",
  },
  {
    sectionKey: "shortcutLightbox",
    keyLabels: ["T"],
    labelKey: "shortcutLightboxThumbnails",
  },
  {
    sectionKey: "shortcutLightbox",
    keyLabels: ["R"],
    labelKey: "shortcutLightboxRotate",
  },
  {
    sectionKey: "shortcutLightbox",
    keyLabels: ["0", "1"],
    labelKey: "shortcutLightboxZoomModes",
  },
  {
    sectionKey: "shortcutLightbox",
    keyLabels: ["Esc"],
    labelKey: "shortcutExitLightbox",
  },
];

interface KeyboardShortcutsProps {
  onClose: () => void;
  open: boolean;
}

export function KeyboardShortcuts({ open, onClose }: KeyboardShortcutsProps) {
  const { t } = useTranslation();
  const sections = [...new Set(SHORTCUTS.map((s) => s.sectionKey))];
  const keyLabel = (key: string) => {
    if (["doubleClick", "click", "rightClick"].includes(key)) {
      return t(key);
    }
    return key;
  };

  return (
    <Dialog
      onOpenChange={(next) => {
        if (!next) {
          onClose();
        }
      }}
      open={open}
    >
      <DialogContent className="max-h-[80vh] overflow-y-auto" size="lg">
        <DialogHeader>
          <DialogTitle>{t("keyboardShortcutsTitle")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          {sections.map((section) => (
            <div key={section}>
              <h3 className="mb-1.5 font-semibold text-[13px] text-foreground uppercase tracking-wider">
                {t(section)}
              </h3>
              <div className="space-y-0.5">
                {SHORTCUTS.filter((s) => s.sectionKey === section).map((s) => (
                  <div
                    className="flex items-center justify-between py-1"
                    key={s.labelKey}
                  >
                    <span className="text-[13px] text-muted-foreground">
                      {t(s.labelKey)}
                    </span>
                    <div className="flex items-center gap-1">
                      {s.keyLabels.map((k, j) => (
                        <span
                          className="min-w-[28px] rounded-[4px] border border-border bg-secondary px-1.5 py-0.5 text-center font-medium text-[11px] text-muted-foreground"
                          key={j}
                        >
                          {keyLabel(k)}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
