import { Clock, ImageIcon, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { imageSearchActions } from "@/actions/image-search";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  type SearchHistoryEntry,
  searchHistoryLabel,
} from "@/types/search-history";
import { cn } from "@/utils/tailwind";
import { SearchTextButton } from "./SearchTextButton";

type Preview = Awaited<ReturnType<typeof imageSearchActions.getPreview>>;
const previews = new Map<
  string,
  { expires: number; result: Promise<Preview> }
>();
function getPreview(path: string) {
  const cached = previews.get(path);
  if (cached && cached.expires > Date.now()) {
    return cached.result;
  }
  if (previews.size >= 100) {
    const first = previews.keys().next().value;
    if (first) {
      previews.delete(first);
    }
  }
  const result = imageSearchActions.getPreview(path);
  previews.set(path, { expires: Date.now() + 30_000, result });
  result.catch(() => previews.delete(path));
  return result;
}

export function SearchHistorySuggestion({
  entry,
  index,
  isActive,
  onClick,
  onMouseEnter,
  onRemove,
}: {
  entry: SearchHistoryEntry;
  index: number;
  isActive: boolean;
  onClick: () => void;
  onMouseEnter: () => void;
  onRemove: (id: string) => void;
}) {
  const { t } = useTranslation();
  const label = searchHistoryLabel(entry);
  const row = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [failedImage, setFailedImage] = useState(false);
  const imagePath = entry.kind === "image" ? entry.imagePath : null;
  useEffect(() => {
    if (!imagePath) {
      return;
    }
    let active = true;
    let started = false;
    const load = () => {
      if (started) {
        return;
      }
      started = true;
      getPreview(imagePath)
        .then((value) => {
          if (active) {
            setPreview(value);
          }
        })
        .catch(() => undefined);
    };
    const observer =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver(
            (entries) => {
              if (entries.some((item) => item.isIntersecting)) {
                load();
                observer?.disconnect();
              }
            },
            {
              root:
                row.current?.closest("[data-search-history-scroll]") ?? null,
            }
          );
    if (observer && row.current) {
      observer.observe(row.current);
    } else {
      load();
    }
    return () => {
      active = false;
      observer?.disconnect();
    };
  }, [imagePath]);
  const missing = preview?.exists === false;
  return (
    <div
      className={cn(
        "group flex min-w-0 items-stretch transition-colors",
        isActive ? "bg-foreground/8" : "hover:bg-foreground/5"
      )}
      data-search-history-row
      ref={row}
    >
      <SearchTextButton
        aria-label={
          imagePath
            ? t("searchHistoryUi.imageLabel", { filename: label })
            : label
        }
        aria-selected={isActive}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left text-[12px] transition-colors",
          isActive
            ? "text-foreground"
            : "text-muted-foreground group-hover:text-foreground"
        )}
        data-suggestion-index={index}
        id={`search-suggestion-${index}`}
        onClick={onClick}
        onMouseDown={(event) => event.preventDefault()}
        onPointerMove={onMouseEnter}
        role="option"
        tabIndex={-1}
        tooltipAlways={Boolean(imagePath)}
        tooltipText={imagePath ?? label}
        type="button"
      >
        {imagePath ? (
          <span className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded bg-muted">
            {preview?.dataUrl && !failedImage ? (
              // biome-ignore lint/a11y/noNoninteractiveElementInteractions: image decoding errors only change its fallback, not user interaction
              <img
                alt=""
                className="h-full w-full object-cover"
                height={28}
                onError={() => setFailedImage(true)}
                src={preview.dataUrl}
                width={28}
              />
            ) : (
              <ImageIcon aria-hidden="true" className="h-4 w-4" />
            )}
          </span>
        ) : (
          <Clock aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
        )}
        <span className="min-w-0 flex-1 truncate" data-search-tooltip-text>
          {label}
        </span>
        {imagePath && (
          <span className="shrink-0 text-[10px] text-muted-foreground">
            {t(missing ? "searchHistoryUi.sourceMissing" : "searchModeImage")}
          </span>
        )}
      </SearchTextButton>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            aria-label={t("searchHistoryUi.remove", { name: label })}
            className="flex w-8 shrink-0 items-center justify-center self-stretch text-muted-foreground hover:bg-foreground/8 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
            data-search-action
            onClick={() => onRemove(entry.id)}
            onMouseDown={(event) => event.preventDefault()}
            onPointerMove={onMouseEnter}
            type="button"
          >
            <X aria-hidden="true" className="h-3.5 w-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent>
          {t("searchHistoryUi.remove", { name: label })}
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
