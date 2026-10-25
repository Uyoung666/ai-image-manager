import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { photoOperationActions } from "@/actions/photo-operations";
import { queryClient } from "@/providers/QueryProvider";

export function usePhotoDeleteUndo() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    result: Awaited<ReturnType<typeof photoOperationActions.deletePhotos>>
  ) => {
    if (result.failedIds.length) {
      toast.error(
        t("deletePartialFailure", { count: result.failedIds.length })
      );
    }
    if (!result.deleted) {
      return;
    }
    let undoStarted = false;
    toast.success(t("toastDeletedCount", { count: result.deleted }), {
      duration: 10_000,
      action: {
        label: t("toastUndo"),
        onClick: async () => {
          if (undoStarted) {
            return;
          }
          undoStarted = true;
          const restored = await photoOperationActions.restoreDeleted(
            result.succeededIds,
            result.deletionBatchId
          );
          for (const key of [
            "photos",
            "folders",
            "albums",
            "trash",
            "deletedPhotos",
            "identities",
          ]) {
            queryClient.invalidateQueries({ queryKey: [key] });
          }
          window.dispatchEvent(new Event("photos-restored"));
          if (restored.succeededIds.length) {
            toast.success(
              t("deleteUndoSuccess", { count: restored.succeededIds.length })
            );
          }
          if (restored.failed) {
            toast.error(t("deleteUndoPartial", { count: restored.failed }));
          }
        },
      },
      cancel: {
        label: t("deleteViewTrash"),
        onClick: () => {
          navigate({ to: "/trash" });
        },
      },
    });
  };
}
