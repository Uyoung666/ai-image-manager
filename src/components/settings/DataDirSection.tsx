import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getLibraryDirectoryInfo } from "@/actions/library-directory";
import { LibraryDirectoryActions } from "./LibraryDirectoryActions";
import { SettingRow } from "./setting-row";

export function DataDirSection() {
  const { t } = useTranslation();
  const [info, setInfo] =
    useState<Awaited<ReturnType<typeof getLibraryDirectoryInfo>>>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    getLibraryDirectoryInfo().then(setInfo, () => setFailed(true));
  }, []);

  return (
    <section className="min-w-0 space-y-3">
      <h2 className="font-semibold text-[14px] text-foreground">
        {t("dataDirectory")}
      </h2>
      <div
        className="min-w-0 space-y-3 rounded-[8px] border border-border bg-secondary p-3 min-[480px]:p-4"
        data-surface="section-card"
      >
        <SettingRow
          action={
            <LibraryDirectoryActions
              currentPath={info?.path ?? ""}
              onChanged={() => window.location.reload()}
            />
          }
          title={
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              {t("currentPath")}
              {info && (
                <span className="rounded-sm bg-foreground/5 px-1.5 py-0.5 text-[11px] text-muted-foreground">
                  {t(
                    info.isDevelopment
                      ? "libraryDirectory_dev"
                      : "libraryDirectory_installed"
                  )}
                </span>
              )}
            </span>
          }
        >
          {failed ? (
            <p className="text-destructive text-xs" role="alert">
              {t("libraryDirectory_error_unavailable")}
            </p>
          ) : (
            <p
              className="font-mono text-foreground/90 text-xs [overflow-wrap:anywhere]"
              data-testid="library-directory-current-path"
            >
              {info?.path ?? "…"}
            </p>
          )}
        </SettingRow>
        {info && (
          <dl className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-border border-t pt-2.5 text-[11px] text-muted-foreground [overflow-wrap:anywhere]">
            <dt>{t("libraryDirectory_profile")}</dt>
            <dd className="min-w-0 font-mono">{info.profilePath}</dd>
          </dl>
        )}
      </div>
    </section>
  );
}
