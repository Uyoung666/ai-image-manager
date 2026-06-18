import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ipc } from "@/ipc/manager";

export function DataDirSection() {
  const { t } = useTranslation();
  const [dataPath, setDataPathState] = useState("");
  const [isDefault, setIsDefault] = useState(true);
  const [msg, setMsg] = useState("");
  const [restarting, setRestarting] = useState(false);
  const [migrating, setMigrating] = useState(false);
  const [progress, setProgress] = useState<{
    current: number;
    total: number;
    label: string;
  } | null>(null);

  useEffect(() => {
    ipc.client.settings.getDataPathInfo({}).then((r) => {
      setDataPathState((r as any).path);
      setIsDefault((r as any).isDefault);
    });
  }, []);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      const data = event.data;
      if (!data || data.channel !== "data-path-migrate-progress") {
        return;
      }
      switch (data.phase) {
        case "start":
          setProgress({
            current: 0,
            total: data.total,
            label: t("preparingMigration"),
          });
          break;
        case "stopping-services":
          setProgress((p) => ({
            current: p?.current ?? 0,
            total: p?.total ?? 0,
            label: t("stoppingServices"),
          }));
          break;
        case "copying":
          setProgress({
            current: data.index - 1,
            total: data.total,
            label: t("copyingDataDir", {
              dir: data.dir,
              index: data.index,
              total: data.total,
            }),
          });
          break;
        case "copied":
          setProgress({
            current: data.index,
            total: data.total,
            label: t("copiedDataDir", {
              dir: data.dir,
              index: data.index,
              total: data.total,
            }),
          });
          break;
        case "skipped":
          setProgress({
            current: data.index,
            total: data.total,
            label: t("skippedDataDir", { dir: data.dir, reason: data.reason }),
          });
          break;
        case "failed":
          setProgress({
            current: data.index,
            total: data.total,
            label: t("dataDirCopyFailed", { dir: data.dir, error: data.error }),
          });
          break;
        case "done":
          setProgress(null);
          break;
        default:
          break;
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  async function handleChangeDir() {
    const result = await ipc.client.shell.openFolderDialog({});
    const newPath = (result as any).path;
    if (!newPath) {
      return;
    }

    setMsg(t("migratingData"));
    setMigrating(true);
    setRestarting(false);
    const setResult = await ipc.client.settings.setDataPath({ newPath });
    const data = setResult as any;
    setMigrating(false);
    if (data.ok) {
      const parts = [t("dataMigratedTo", { path: newPath })];
      if (data.copied > 0) {
        parts.push(t("dataMigratedDirs", { count: data.copied }));
      }
      if (data.cleaned > 0) {
        parts.push(t("cleanedOldDirs", { count: data.cleaned }));
      }
      if (data.errors?.length > 0) {
        parts.push(
          t("dataMigrationPartialFailed", { errors: data.errors.join("; ") })
        );
      }
      if (data.cleanupErrors?.length > 0) {
        parts.push(
          t("cleanupOldDataPartialFailed", {
            errors: data.cleanupErrors.join("; "),
          })
        );
      }
      setMsg(`${parts.join("")}${t("refreshingAfterMigration")}`);
      setDataPathState(newPath);
      setIsDefault(false);
      setRestarting(true);
      // Services have already been restarted in-place by the main process.
      // A renderer reload re-establishes the oRPC port and refetches data
      // from the new location. No app relaunch needed (which is unreliable
      // under `npm run dev` because forge tears down the dev server).
      setTimeout(() => {
        window.location.reload();
      }, 1500);
    } else {
      setMsg(data.error || t("dataPathSetFailed"));
    }
  }

  const percent =
    progress && progress.total > 0
      ? Math.min(100, Math.round((progress.current / progress.total) * 100))
      : 0;

  return (
    <section className="space-y-3">
      <h2 className="font-semibold text-[14px] text-foreground">
        {t("dataDirectory")}
      </h2>
      <div className="space-y-3 rounded-[8px] border border-border bg-secondary p-4">
        <div>
          <span className="text-[13px] text-muted-foreground">
            {t("currentPath")}
          </span>
          <p className="mt-0.5 break-all font-mono text-[11px] text-muted-foreground/70">
            {dataPath || "..."}
          </p>
          <p className="mt-0.5 text-[11px] text-muted-foreground/50">
            {isDefault ? t("defaultPath") : t("customPath")}
          </p>
        </div>
        <div className="border-border border-t pt-3">
          <button
            className="rounded-[6px] border border-input px-3 py-1.5 text-[12px] text-muted-foreground transition-colors hover:border-muted-foreground/30 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            disabled={restarting || migrating}
            onClick={handleChangeDir}
          >
            {restarting
              ? t("refreshing")
              : migrating
                ? t("migrating")
                : t("chooseDirectory")}
          </button>
          {progress && (
            <div className="mt-3 space-y-1.5">
              <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full bg-primary transition-all duration-300"
                  style={{ width: `${percent}%` }}
                />
              </div>
              <p className="text-[11px] text-muted-foreground/70">
                {progress.label}
              </p>
            </div>
          )}
          {msg && (
            <p className="mt-2 text-[12px] text-muted-foreground">{msg}</p>
          )}
        </div>
      </div>
    </section>
  );
}
