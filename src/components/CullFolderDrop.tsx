import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ImportDropLayer } from "@/components/import-drop-layer";
import { useImportDropZones } from "@/hooks/use-import-drop-zones";

export function CullFolderDrop({
  enabled,
  disabled,
  onFolder,
  children,
}: {
  enabled: boolean;
  disabled: boolean;
  onFolder: (path: string) => Promise<void>;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const zones = useImportDropZones({
    onImageSearch: () => undefined,
    onFolderDrop: async (paths) => {
      if (disabled) {
        return;
      }
      if (paths.length !== 1) {
        toast.info(t("cullProject.dropOneFolder"));
        return;
      }
      await onFolder(paths[0]);
    },
  });
  const accepting = enabled && !disabled;
  return (
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: This page owns the native external folder drag lifecycle, matching the home workspace.
    <section
      aria-label={t("cullTitle")}
      className="relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background"
      data-surface="page"
      onDragEnter={accepting ? zones.handleRootDragEnter : undefined}
      onDragLeave={accepting ? zones.handleRootDragLeave : undefined}
      onDragOver={accepting ? zones.handleRootDragOver : undefined}
      onDrop={accepting ? zones.handleRootDrop : undefined}
    >
      {accepting && (
        <ImportDropLayer
          kind={zones.dragKind}
          label={t("cullProject.dropFolder")}
          onDragOver={zones.handleZoneDragOver}
          onDrop={zones.handleZoneDrop}
          zone="folders"
        />
      )}
      {children}
    </section>
  );
}
