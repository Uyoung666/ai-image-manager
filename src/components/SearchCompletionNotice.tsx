import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export function SearchCompletionNotice({
  inline = false,
  onRetry,
}: {
  inline?: boolean;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  const message = t("searchPartialResults");
  return (
    <div
      className={`flex min-w-0 items-center gap-2 ${inline ? "text-[11px]" : "flex-wrap border-b px-4 py-2 text-xs"}`}
      role="status"
    >
      {inline ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className="min-w-0 truncate"
              // biome-ignore lint/a11y/noNoninteractiveTabindex: let keyboard users read the full message.
              tabIndex={0}
            >
              {message}
            </span>
          </TooltipTrigger>
          <TooltipContent>{message}</TooltipContent>
        </Tooltip>
      ) : (
        <span className="min-w-0 break-words">{message}</span>
      )}
      <Button
        className="h-auto shrink-0 px-0 underline"
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
