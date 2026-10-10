import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";

export function SearchCompletionNotice({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-2 border-b px-4 py-2 text-xs"
      role="status"
    >
      <span className="min-w-0 break-words">{t("searchPartialResults")}</span>
      <Button
        className="h-auto px-0 underline"
        onClick={onRetry}
        size="sm"
        type="button"
        variant="link"
      >
        {t("retry")}
      </Button>
    </div>
  );
}
