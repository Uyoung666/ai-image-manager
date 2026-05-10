import Lightbox from "yet-another-react-lightbox";
import "yet-another-react-lightbox/styles.css";

interface Photo {
  filename: string;
  height: number;
  id: number;
  path: string;
  width: number;
}

interface PhotoLightboxProps {
  index: number;
  onClose: () => void;
  open: boolean;
  photos: Photo[];
}

function toLocalMediaUrl(filePath: string): string {
  const encoded = filePath
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `local-media://${encoded}`;
}

export function PhotoLightbox({
  photos,
  index,
  open,
  onClose,
}: PhotoLightboxProps) {
  const slides = photos.map((p) => ({
    src: toLocalMediaUrl(p.path),
    alt: p.filename,
    title: p.filename,
  }));

  return <Lightbox close={onClose} index={index} open={open} slides={slides} />;
}
