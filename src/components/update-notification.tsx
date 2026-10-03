import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  getUpdateStatus,
  installDownloadedUpdate,
  resumeUpdate,
} from "@/actions/update";
import { UpdateProgress } from "@/components/update-progress";
import {
  UPDATE_ERROR_KEYS,
  type UpdateResult,
  type UpdateStatus,
} from "@/types/update";
import { classifyUpdateError } from "@/utils/update-error";

export function UpdateNotification({ reminder }: { reminder: boolean }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<UpdateStatus>({ phase: "idle" });
  const actionRunning = useRef(false);
  const toastId = useRef<string | number | undefined>(undefined);
  useEffect(() => {
    let active = true;
    let revision = 0;
    const receive = (event: MessageEvent) => {
      if (event.data?.channel !== "update:status") {
        return;
      }
      revision++;
      setStatus(event.data);
    };
    window.addEventListener("message", receive);
    getUpdateStatus()
      .then((value) => {
        if (active && revision === 0) {
          setStatus(value);
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
      window.removeEventListener("message", receive);
      if (toastId.current !== undefined) {
        toast.dismiss(toastId.current);
      }
    };
  }, []);
  useEffect(() => {
    async function run(
      action: () => Promise<UpdateResult>,
      phase: "installing" | "downloading"
    ) {
      if (actionRunning.current) {
        return;
      }
      actionRunning.current = true;
      toastId.current = toast.loading(
        t(phase === "installing" ? "updateInstalling" : "updateDownloading"),
        {
          id: toastId.current,
          action: undefined,
          duration: Number.POSITIVE_INFINITY,
        }
      );
      try {
        const result = await action();
        if (!result.ok) {
          throw new Error(result.error);
        }
      } catch (error) {
        toastId.current = toast.error(
          t(UPDATE_ERROR_KEYS[classifyUpdateError(error)]),
          {
            id: toastId.current,
            action: undefined,
            duration: 30_000,
          }
        );
      } finally {
        actionRunning.current = false;
      }
    }
    if (
      [
        "installing",
        "recovering",
        "restarting",
        "downloading",
        "retry-wait",
      ].includes(status.phase)
    ) {
      toastId.current = toast.info(<UpdateProgress status={status} />, {
        id: toastId.current,
        icon: null,
        action: undefined,
        duration: Number.POSITIVE_INFINITY,
        dismissible: false,
      });
    } else if (status.phase === "downloaded" && reminder) {
      toastId.current = toast.info(
        t("updateDownloaded", { version: status.version }),
        {
          id: toastId.current,
          icon: null,
          duration: 30_000,
          action: {
            label: t("updateRestart"),
            onClick: (event) => {
              event.preventDefault();
              run(installDownloadedUpdate, "installing");
            },
          },
        }
      );
    } else if (
      status.phase === "error" &&
      (status.operation === "install" || status.canResume)
    ) {
      toastId.current = toast.error(
        t(UPDATE_ERROR_KEYS[classifyUpdateError(status.message)]),
        {
          id: toastId.current,
          duration: 30_000,
          icon: undefined,
          action: {
            label: t("updateRetry"),
            onClick: (event) => {
              event.preventDefault();
              run(
                status.canResume ? resumeUpdate : installDownloadedUpdate,
                status.canResume ? "downloading" : "installing"
              );
            },
          },
        }
      );
    } else if (toastId.current !== undefined) {
      toast.dismiss(toastId.current);
      toastId.current = undefined;
    }
  }, [status, reminder, t]);
  return null;
}
