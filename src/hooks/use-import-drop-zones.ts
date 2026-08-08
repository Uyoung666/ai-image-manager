import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ipc } from "@/ipc/manager";
import {
  classifyExternalDrop,
  type ExternalDropKind,
  getDroppedFolderPaths,
  getDroppedImagePath,
} from "@/utils/drop-import";

type ImportDropZone = "image" | "folders";

interface UseImportDropZonesOptions {
  onImageSearch: (imagePath: string) => void | Promise<void>;
}

function getRejectedDropMessage(
  kind: ExternalDropKind,
  zone: ImportDropZone,
  t: (key: string) => string
): string {
  if (kind === "invalid") {
    return t("dropUnsupportedItems");
  }
  if (zone === "image") {
    return t("dropFoldersToImportOnly");
  }
  return t("dropImageToSearchOnly");
}

async function enqueueFolderImports(
  folderPaths: string[],
  t: (key: string, options?: { count: number }) => string
): Promise<void> {
  let enqueued = 0;
  let alreadyQueued = 0;
  let failed = 0;

  for (const folderPath of folderPaths) {
    try {
      const result = await ipc.client.photos.scanFolder({ path: folderPath });
      if (result.status === "queued") {
        enqueued++;
      } else {
        alreadyQueued++;
      }
    } catch (error) {
      failed++;
      console.error(`[folderDrop] scanFolder failed for ${folderPath}:`, error);
    }
  }

  if (enqueued > 0) {
    toast.success(
      enqueued === 1
        ? t("toastImportQueued")
        : t("toastImportQueuedMultiple", { count: enqueued })
    );
  }
  if (alreadyQueued > 0) {
    toast.info(t("toastImportAlreadyQueued", { count: alreadyQueued }));
  }
  if (failed > 0) {
    toast.error(t("toastScanFolderFailed"));
  }
}

export function useImportDropZones({
  onImageSearch,
}: UseImportDropZonesOptions) {
  const { t } = useTranslation();
  const [dragKind, setDragKind] = useState<ExternalDropKind | null>(null);

  const clearDragState = useCallback(() => {
    setDragKind(null);
  }, []);

  useEffect(() => {
    window.addEventListener("blur", clearDragState);
    return () => window.removeEventListener("blur", clearDragState);
  }, [clearDragState]);

  const handleRootDragEnter = useCallback(
    (event: React.DragEvent) => {
      const kind = classifyExternalDrop(event.dataTransfer);
      if (kind === null) {
        clearDragState();
        return;
      }
      event.stopPropagation();
      setDragKind(kind);
    },
    [clearDragState]
  );

  const handleRootDragOver = useCallback(
    (event: React.DragEvent) => {
      const kind = classifyExternalDrop(event.dataTransfer);
      if (kind === null) {
        clearDragState();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "none";
      setDragKind(kind);
    },
    [clearDragState]
  );

  const handleRootDragLeave = useCallback(
    (event: React.DragEvent) => {
      const relatedTarget = event.relatedTarget as Node | null;
      if (relatedTarget && event.currentTarget.contains(relatedTarget)) {
        return;
      }
      clearDragState();
    },
    [clearDragState]
  );

  const handleRootDrop = useCallback(
    (event: React.DragEvent) => {
      if (classifyExternalDrop(event.dataTransfer) === null) {
        clearDragState();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      clearDragState();
    },
    [clearDragState]
  );

  const handleZoneDragOver = useCallback(
    (event: React.DragEvent, zone: ImportDropZone) => {
      const kind = classifyExternalDrop(event.dataTransfer);
      if (kind === null) {
        clearDragState();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = kind === zone ? "copy" : "none";
    },
    [clearDragState]
  );

  const handleZoneDrop = useCallback(
    async (event: React.DragEvent, zone: ImportDropZone) => {
      const kind = classifyExternalDrop(event.dataTransfer);
      event.preventDefault();
      event.stopPropagation();
      clearDragState();

      if (kind === null) {
        return;
      }
      if (kind !== zone) {
        toast.error(getRejectedDropMessage(kind, zone, t));
        return;
      }

      if (zone === "image") {
        const imagePath = getDroppedImagePath(event.dataTransfer);
        if (!imagePath) {
          toast.error(t("toastImageDropFailed"));
          return;
        }
        await onImageSearch(imagePath);
        return;
      }

      const folderPaths = getDroppedFolderPaths(event.dataTransfer);
      if (folderPaths.length === 0) {
        toast.error(t("toastFolderDropFailed"));
        return;
      }
      await enqueueFolderImports(folderPaths, t);
    },
    [clearDragState, onImageSearch, t]
  );

  return {
    dragKind,
    handleRootDragEnter,
    handleRootDragOver,
    handleRootDragLeave,
    handleRootDrop,
    handleZoneDragOver,
    handleZoneDrop,
  };
}
