import { memo } from "react";

interface MasonryBackToTopProps {
  label: string;
  onClick: (e: React.MouseEvent) => void;
  selectionActive: boolean;
  show: boolean;
}

export const MasonryBackToTop = memo(function MasonryBackToTop({
  label,
  onClick,
  selectionActive,
  show,
}: MasonryBackToTopProps) {
  return (
    <button
      aria-hidden={!show}
      aria-label={label}
      className={`scroll-to-top-btn absolute right-4 z-40 focus-visible:ring-2 focus-visible:ring-ring/50 ${
        selectionActive ? "bottom-[92px]" : "bottom-11"
      } ${
        show
          ? "scale-100 opacity-100"
          : "pointer-events-none scale-75 opacity-0"
      }`}
      data-text={label}
      onClick={onClick}
      tabIndex={show ? 0 : -1}
      type="button"
    >
      <svg className="scroll-to-top-icon" viewBox="0 0 384 512">
        <path d="M214.6 41.4c-12.5-12.5-32.8-12.5-45.3 0l-160 160c-12.5 12.5-12.5 32.8 0 45.3s32.8 12.5 45.3 0L160 141.2V448c0 17.7 14.3 32 32 32s32-14.3 32-32V141.2L329.4 246.6c12.5 12.5 32.8 12.5 45.3 0s12.5-32.8 0-45.3l-160-160z" />
      </svg>
    </button>
  );
});
