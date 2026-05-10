import Lightbox from "yet-another-react-lightbox";
import "yet-another-react-lightbox/styles.css";

interface Photo {
  id: number; path: string; filename: string;
  width: number; height: number;
}

interface PhotoLightboxProps {
  photos: Photo[];
  index: number;
  open: boolean;
  onClose: () => void;
}

function toLocalMediaUrl(filePath: string): string {
  const encoded = filePath
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `local-media://${encoded}`;
}

export function PhotoLightbox({ photos, index, open, onClose }: PhotoLightboxProps) {
  const slides = photos.map((p) => ({
    src: toLocalMediaUrl(p.path),
    alt: p.filename,
    title: p.filename,
  }));

  return (
    <Lightbox
      open={open}
      close={onClose}
      index={index}
      slides={slides}
    />
  );
}
