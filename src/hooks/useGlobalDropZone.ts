import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ipc } from "@/ipc/manager";

/** 全局拖拽导入 — 从文件管理器拖入文件夹/图片到主区域触发后台队列扫描 */
export function useGlobalDropZone() {
  const { t } = useTranslation();

  const handleGlobalDragOver = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("Files")) {
      return;
    }
    const hasFile = Array.from(e.dataTransfer.items).some(
      (item) => item.kind === "file"
    );
    if (!hasFile) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "copy";
  }, []);

  const handleGlobalDrop = useCallback(
    async (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes("Files")) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();

      const items = Array.from(e.dataTransfer.items);
      const folders = new Set<string>();

      for (const item of items) {
        if (item.kind !== "file") {
          continue;
        }
        const entry = item.webkitGetAsEntry?.();
        const file = item.getAsFile();
        if (!file) {
          continue;
        }
        const filePath = (window as any).electronAPI?.getFilePath?.(file);
        if (!filePath) {
          continue;
        }
        if (entry?.isDirectory) {
          folders.add(filePath);
        } else {
          const parent = filePath.replace(/[\\/][^\\/]+$/, "");
          if (parent) {
            folders.add(parent);
          }
        }
      }

      if (folders.size === 0) {
        return;
      }

      // 全部入队 — 每个 scanFolder 立即返回 { status: "queued", position }
      // 不会阻塞 UI，后台队列按顺序逐个处理
      let enqueued = 0;
      for (const folderPath of folders) {
        try {
          const result = await ipc.client.photos.scanFolder({
            path: folderPath,
          });
          if (result.status === "queued") {
            enqueued++;
          }
        } catch (err: any) {
          console.error(
            `[globalDrop] scanFolder failed for ${folderPath}:`,
            err
          );
        }
      }

      if (enqueued > 0) {
        toast.success(
          folders.size === 1
            ? t("toastImportQueued")
            : t("toastImportQueuedMultiple", { count: enqueued })
        );
      } else {
        toast.error(t("toastScanFolderFailed"));
      }
    },
    [t]
  );

  return { handleGlobalDragOver, handleGlobalDrop };
}
