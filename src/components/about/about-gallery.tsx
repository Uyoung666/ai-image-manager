import { useState } from "react";
import { useTranslation } from "react-i18next";
import image01 from "@/assets/about/01.webp";
import image02 from "@/assets/about/02.webp";
import image03 from "@/assets/about/03.webp";
import image04 from "@/assets/about/04.webp";
import image05 from "@/assets/about/05.webp";
import { useReducedMotion } from "@/hooks/use-reduced-motion";

const ARTWORKS = [image01, image02, image03, image04, image05].map(
  (src, index) => ({
    src,
    id: String(index + 1).padStart(2, "0"),
    altKey: `aboutArtwork${index + 1}`,
    position: "50% 50%",
  })
);

function Artwork({
  src,
  alt,
  position,
}: {
  src: string;
  alt: string;
  position: string;
}) {
  const [failed, setFailed] = useState(false);
  const { t } = useTranslation();
  if (failed) {
    return (
      <span className="about-artwork-fallback">
        {t("aboutImageUnavailable")}
      </span>
    );
  }
  return (
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: onError handles failed image loading, not input interaction.
    <img
      alt={alt}
      className="about-artwork"
      decoding="async"
      draggable={false}
      height={1448}
      onError={() => setFailed(true)}
      src={src}
      style={{ objectPosition: position }}
      width={1086}
    />
  );
}

export function AboutGallery() {
  const { t } = useTranslation();
  const reduceMotion = useReducedMotion();
  const [selected, setSelected] = useState(2);
  const [hovered, setHovered] = useState<number | null>(null);
  const [focused, setFocused] = useState<number | null>(null);
  const active = hovered ?? focused ?? selected;

  return (
    <section
      aria-label={t("aboutGalleryTitle")}
      className="about-gallery-section"
      data-reduced-motion={reduceMotion}
    >
      <div className="flex min-w-0 items-center justify-between gap-3">
        <h3 className="font-medium text-[12px] text-muted-foreground">
          {t("aboutGalleryTitle")}
        </h3>
        <span
          aria-hidden="true"
          className="font-mono text-[10px] text-muted-foreground/60"
        >
          {ARTWORKS[selected].id} / 05
        </span>
      </div>
      <div className="about-gallery" data-testid="about-gallery">
        {ARTWORKS.map((artwork, index) => (
          <button
            aria-label={t("aboutSelectArtwork", {
              number: index + 1,
              description: t(artwork.altKey),
            })}
            aria-pressed={selected === index}
            className="about-gallery-card"
            data-active={active === index}
            key={artwork.id}
            onBlur={() => setFocused(null)}
            onClick={() => setSelected(index)}
            onFocus={(event) => {
              setFocused(index);
              setHovered(null);
              // Only scroll the internal strip, never the settings page.
              const strip = event.currentTarget.parentElement;
              if (strip && strip.scrollWidth > strip.clientWidth) {
                const left = event.currentTarget.offsetLeft - strip.offsetLeft;
                strip.scrollLeft = Math.max(
                  0,
                  left -
                    (strip.clientWidth - event.currentTarget.clientWidth) / 2
                );
              }
            }}
            onMouseEnter={() => setHovered(index)}
            onMouseLeave={() => setHovered(null)}
            type="button"
          >
            <Artwork
              alt={t(artwork.altKey)}
              position={artwork.position}
              src={artwork.src}
            />
            <span aria-hidden="true" className="about-artwork-number">
              {artwork.id}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
