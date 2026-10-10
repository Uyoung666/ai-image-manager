import { AlertTriangle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";

/** A persistent recovery entry for an incompatible index, without resetting it. */
export function AiIndexRebuildNotice({
  onOpenSettings,
}: {
  onOpenSettings: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      aria-label={t("aiIndexRebuildRequired")}
      className="flex min-w-0 flex-wrap items-start gap-3 rounded-[8px] border border-warning/30 bg-warning/10 p-3"
      data-ai-index-rebuild-notice
      role="alert"
    >
      <AlertTriangle
        aria-hidden="true"
        className="mt-0.5 h-4 w-4 shrink-0 text-warning"
      />
      <div className="min-w-0 flex-1 basis-60 space-y-1">
        <p className="font-medium text-[13px] text-foreground">
          {t("aiIndexRebuildRequired")}
        </p>
        <p className="break-words text-[12px] text-foreground leading-relaxed">
          {t("aiIndexRebuildNoticeDescription")}
        </p>
        <p className="break-words text-[12px] text-muted-foreground leading-relaxed">
          {t("aiIndexRebuildFallback")}
        </p>
      </div>
      <Button
        className="h-auto min-h-8 max-w-full whitespace-normal text-[12px]"
        onClick={onOpenSettings}
        onKeyDown={(event) => {
          // Keep the recovery button's native activation independent of search shortcuts.
          if (event.key === "Enter" || event.key === " ") {
            event.stopPropagation();
          }
        }}
        size="sm"
        type="button"
      >
        {t("aiIndexOpenSettings")}
      </Button>
    </div>
  );
}
