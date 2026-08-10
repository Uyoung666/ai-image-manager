import { useCallback, useEffect, useRef, useState } from "react";
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
  const scrollRef = useRef<HTMLDivElement>(null);
  const [hasMoreBelow, setHasMoreBelow] = useState(false);
  const sections = [...new Set(SHORTCUTS.map((s) => s.sectionKey))];
  const updateBottomFade = useCallback(() => {
    const element = scrollRef.current;
    if (!element) {
      setHasMoreBelow(false);
      return;
    }
    setHasMoreBelow(
      element.scrollHeight - element.scrollTop - element.clientHeight > 2
    );
  }, []);

  useEffect(() => {
    if (!open) {
      setHasMoreBelow(false);
      return;
    }
    const element = scrollRef.current;
    if (!element) {
      return;
    }
    updateBottomFade();
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(updateBottomFade);
    observer.observe(element);
    return () => observer.disconnect();
  }, [open, updateBottomFade]);

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
      <DialogContent
        className="flex max-h-[calc(100dvh-5rem)] min-h-0 flex-col overflow-hidden max-[480px]:max-h-[calc(100dvh-3rem)]"
        size="lg"
      >
        <DialogHeader>
          <DialogTitle>{t("keyboardShortcutsTitle")}</DialogTitle>
        </DialogHeader>
        <div
          className="resource-tree-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain"
          data-bottom-fade={hasMoreBelow}
          onScroll={updateBottomFade}
          ref={scrollRef}
        >
          <div className="space-y-4">
            {sections.map((section) => (
              <div key={section}>
                <h3 className="mb-1.5 font-semibold text-[13px] text-foreground uppercase tracking-wider">
                  {t(section)}
                </h3>
                <div className="space-y-0.5">
                  {SHORTCUTS.filter((s) => s.sectionKey === section).map(
                    (s) => (
                      <div
                        className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 py-1"
                        key={s.labelKey}
                      >
                        <span className="min-w-0 flex-[1_1_12rem] text-[13px] text-muted-foreground [overflow-wrap:anywhere]">
                          {t(s.labelKey)}
                        </span>
                        <div className="flex flex-wrap items-center justify-end gap-1">
                          {s.keyLabels.map((k) => (
                            <span
                              className="min-w-[28px] rounded-[4px] border border-border bg-secondary px-1.5 py-0.5 text-center font-medium text-[11px] text-muted-foreground"
                              key={`${s.labelKey}-${k}`}
                            >
                              {keyLabel(k)}
                            </span>
                          ))}
                        </div>
                      </div>
                    )
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
