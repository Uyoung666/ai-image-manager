import { Ban, FolderInput, ImageUp } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ExternalDropKind } from "@/utils/drop-import";

type ImportDropZone = "image" | "folders";

interface ImportDropLayerProps {
  className?: string;
  kind: ExternalDropKind | null;
  onDragOver: (event: React.DragEvent, zone: ImportDropZone) => void;
  onDrop: (event: React.DragEvent, zone: ImportDropZone) => void;
  zone: ImportDropZone;
}

function getZoneLabel(zone: ImportDropZone, t: (key: string) => string) {
  return zone === "image" ? t("dropImageToSearch") : t("dropFoldersToImport");
}

function getZoneIcon(zone: ImportDropZone, allowed: boolean) {
  if (!allowed) {
    return <Ban aria-hidden="true" className="h-5 w-5" />;
  }
  if (zone === "image") {
    return <ImageUp aria-hidden="true" className="h-5 w-5" />;
  }
  return <FolderInput aria-hidden="true" className="h-5 w-5" />;
}

export function ImportDropLayer({
  kind,
  onDragOver,
  onDrop,
  className,
  zone,
}: ImportDropLayerProps) {
  const { t } = useTranslation();

  if (!kind) {
    return null;
  }

  const allowed = kind === zone;
  const label = getZoneLabel(zone, t);

  return (
    <div
      aria-live="polite"
      className={`import-drop-layer ${className ?? ""}`}
      role="status"
    >
      <button
        aria-label={label}
        className={`import-drop-zone ${allowed ? "is-allowed" : "is-forbidden"}`}
        onDragOver={(event) => onDragOver(event, zone)}
        onDrop={(event) => onDrop(event, zone)}
        type="button"
      >
        <span className="import-drop-zone-content">
          {getZoneIcon(zone, allowed)}
          <span>{label}</span>
        </span>
      </button>
    </div>
  );
}
