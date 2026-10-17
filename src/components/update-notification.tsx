import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useUpdateUi, useUpdateUiActions } from "@/hooks/use-update-ui";
import { UPDATE_ERROR_KEYS } from "@/types/update";

export function UpdateNotification() {
  const { t } = useTranslation();
  const notice = useUpdateUi((state) => state.notice);
  const actions = useUpdateUiActions();
  const toastId = useRef<string | number | undefined>(undefined);
  const shownNotice = useRef<number | null>(null);
  useEffect(() => {
    if (!notice) {
      if (toastId.current !== undefined) {
        toast.dismiss(toastId.current);
        toastId.current = undefined;
      }
      return;
    }
    if (shownNotice.current === notice.id) {
      return;
    }
    shownNotice.current = notice.id;
    const options = {
      id: toastId.current,
      duration: 8000,
      closeButton: true,
      dismissible: true,
      action: {
        label: t("updateViewDetails"),
        onClick: () => actions.setDetailsOpen(true),
      },
    };
    toastId.current =
      notice.kind === "ready"
        ? toast.info(
            t("updateDownloaded", { version: notice.version }),
            options
          )
        : toast.error(
            t(UPDATE_ERROR_KEYS[notice.error ?? "UPDATE_UNKNOWN_ERROR"]),
            options
          );
  }, [notice, actions, t]);
  useEffect(
    () => () => {
      if (toastId.current !== undefined) {
        toast.dismiss(toastId.current);
      }
    },
    []
  );
  return null;
}
