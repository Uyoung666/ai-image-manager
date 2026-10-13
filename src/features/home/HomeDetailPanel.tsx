import type { ComponentProps, Ref } from "react";
import { useTranslation } from "react-i18next";
import { PhotoDetailPanel } from "@/components/PhotoDetailPanel";
import { SequenceDetailPanel } from "@/components/SequenceDetailPanel";

interface HomeDetailPanelProps {
  compactDetailOverlay: boolean;
  detailOverlayRef: Ref<HTMLElement>;
  detailPanelWidth: number;
  onClose: () => void;
  photo: ComponentProps<typeof PhotoDetailPanel>;
  sequence: ComponentProps<typeof SequenceDetailPanel>;
  sequenceActive: boolean;
}
export function HomeDetailPanel({
  compactDetailOverlay,
  detailPanelWidth,
  detailOverlayRef,
  sequenceActive,
  onClose,
  photo,
  sequence,
}: HomeDetailPanelProps) {
  const { t } = useTranslation();
  return (
    <>
      <button
        aria-label={t("close")}
        className="photo-detail-panel-backdrop"
        onClick={onClose}
        type="button"
      />
      <aside
        aria-label={t("photoDetail")}
        className="home-detail-panel-container relative shrink-0 overflow-hidden"
        data-surface="inspector"
        ref={detailOverlayRef}
        role={compactDetailOverlay ? "dialog" : "complementary"}
        style={{ width: detailPanelWidth }}
      >
        <h2 className="sr-only">{t("photoDetail")}</h2>
        {/* 照片详情层 — 始终挂载，序列激活时交叉淡出 */}
        <div
          className="absolute inset-0"
          style={{
            opacity: sequenceActive ? 0 : 1,
            pointerEvents: sequenceActive ? "none" : "auto",
            transition: "opacity 200ms ease",
          }}
        >
          <PhotoDetailPanel {...photo} />
        </div>

        {/* 序列详情层 — 需要时才挂载，挂载后淡入 */}
        {sequenceActive && (
          <div
            className="absolute inset-0"
            style={{ transition: "opacity 200ms ease" }}
          >
            <SequenceDetailPanel {...sequence} />
          </div>
        )}
      </aside>
    </>
  );
}
