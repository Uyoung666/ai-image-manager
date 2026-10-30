import { Images } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SearchSuggestion } from "@/components/search-bar-utils";
import { useGalleryThumbnail } from "@/hooks/useGalleryThumbnail";
import { SearchTextButton } from "./SearchTextButton";
import "./search-starter-gallery.css";

function sourceLabel(example: SearchSuggestion): string {
  if (example.kind === "month") {
    return "searchStarterUi.month";
  }
  if (example.kind === "tag") {
    return "searchStarterUi.byTag";
  }
  return `searchStarterUi.source.${example.source ?? "library"}`;
}

function ManagedCover({
  id,
  version,
  onFailure,
}: {
  id: number;
  version?: string;
  onFailure: () => void;
}) {
  const image = useGalleryThumbnail({
    id,
    version: `${version ?? "search-starter"}:${id}`,
    width: 144,
    height: 160,
    enabled: true,
    priority: 0,
    visible: true,
    idle: false,
  });
  useEffect(() => {
    if (image.failed) {
      onFailure();
    }
  }, [image.failed, onFailure]);
  return (
    <div className="absolute inset-0" ref={image.ref}>
      {image.url && (
        // biome-ignore lint/a11y/noNoninteractiveElementInteractions: image events acknowledge loading and try the next verified cover.
        <img
          alt=""
          className="h-full w-full object-cover"
          decoding="async"
          draggable={false}
          height={160}
          onError={onFailure}
          onLoad={() => image.onDisplayed(image.url)}
          src={image.url}
          width={144}
        />
      )}
    </div>
  );
}

function StarterCover({ ids, version }: { ids: number[]; version?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const failed = useCallback(
    () => setAttempt((value) => (value === attempt ? value + 1 : value)),
    [attempt]
  );
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      return;
    }
    const observer = new IntersectionObserver(([entry]) =>
      setVisible(entry.isIntersecting)
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <div aria-hidden="true" className="search-starter-cover" ref={ref}>
      <Images className="h-7 w-7 text-primary/40" />
      {visible && ids[attempt] !== undefined && (
        <ManagedCover
          id={ids[attempt]}
          key={ids[attempt]}
          onFailure={failed}
          version={version}
        />
      )}
    </div>
  );
}

export function SearchStarterGallery({
  examples,
  loading,
  status,
  suggestionIndex,
  onSelect,
  onHighlight,
}: {
  examples: SearchSuggestion[];
  loading: boolean;
  status: string;
  suggestionIndex: number;
  onSelect: (suggestion: SearchSuggestion) => void;
  onHighlight: (index: number) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="search-starter-gallery-container">
      <div
        aria-busy={loading}
        className="search-starter-gallery"
        data-starter-grid
        data-starter-state={loading ? "loading" : status}
      >
        {examples.map((example, index) => (
          <SearchTextButton
            aria-label={example.text}
            aria-selected={index === suggestionIndex}
            className="search-starter-card"
            data-active={index === suggestionIndex}
            data-suggestion-index={index}
            id={`search-suggestion-${index}`}
            key={example.key ?? example.text}
            onClick={() => onSelect(example)}
            onFocus={() => onHighlight(index)}
            onMouseDown={(event) => event.preventDefault()}
            onPointerLeave={(event) => {
              if (
                index === suggestionIndex &&
                event.currentTarget !== document.activeElement
              ) {
                onHighlight(-1);
              }
            }}
            onPointerMove={() => onHighlight(index)}
            role="option"
            tabIndex={-1}
            tooltipText={example.text}
            type="button"
          >
            <StarterCover
              ids={example.previewPhotoIds ?? []}
              key={`${example.previewVersion ?? ""}:${(example.previewPhotoIds ?? []).join(",")}`}
              version={example.previewVersion}
            />
            <span className="search-starter-caption">
              <span
                className="search-starter-card-title"
                data-search-tooltip-text
              >
                {example.text}
              </span>
              <span className="search-starter-card-source">
                {t(sourceLabel(example))}
              </span>
            </span>
          </SearchTextButton>
        ))}
        {examples.length === 0 &&
          loading &&
          [0, 1, 2, 3].map((slot) => (
            <div
              aria-hidden="true"
              className="search-starter-card search-starter-skeleton motion-safe:animate-pulse"
              key={slot}
            />
          ))}
      </div>
    </div>
  );
}
