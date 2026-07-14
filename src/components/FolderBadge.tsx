/** biome-ignore-all lint/style/useFilenamingConvention: React component files use the project's PascalCase convention. */
import {
  Archive,
  Briefcase,
  Camera,
  Cloud,
  Download,
  FileText,
  Folder,
  Heart,
  Home,
  Image,
  MapPin,
  Mountain,
  Music,
  Palette,
  PawPrint,
  Plane,
  Star,
  User,
  Users,
  Video,
} from "lucide-react";
import type { ComponentType, CSSProperties } from "react";
import {
  type FolderAppearanceIcon,
  getFolderAppearance,
} from "@/lib/folder-appearance";
import type { Folder as FolderType } from "@/types/photo";

const ICONS: Record<
  FolderAppearanceIcon,
  ComponentType<{ className?: string }>
> = {
  archive: Archive,
  briefcase: Briefcase,
  camera: Camera,
  cloud: Cloud,
  download: Download,
  "file-text": FileText,
  folder: Folder,
  heart: Heart,
  home: Home,
  image: Image,
  "map-pin": MapPin,
  mountain: Mountain,
  music: Music,
  palette: Palette,
  "paw-print": PawPrint,
  plane: Plane,
  star: Star,
  user: User,
  users: Users,
  video: Video,
};

interface FolderBadgeProps {
  className?: string;
  folder: Pick<
    FolderType,
    "appearanceColor" | "appearanceIcon" | "displayName" | "path"
  >;
}

export function FolderBadge({
  className = "h-[18px] w-[18px]",
  folder,
}: FolderBadgeProps) {
  const appearance = getFolderAppearance(folder);
  const Icon = appearance.icon ? ICONS[appearance.icon] : null;

  return (
    <span
      aria-hidden="true"
      className={`folder-badge inline-flex flex-shrink-0 items-center justify-center rounded-[5px] font-semibold text-[10px] leading-none ${className}`}
      data-folder-badge="true"
      data-folder-color={appearance.color}
      data-folder-icon={appearance.icon ?? "initial"}
      style={{ "--folder-badge-color": appearance.color } as CSSProperties}
    >
      {Icon ? <Icon className="h-[65%] w-[65%]" /> : appearance.initial}
    </span>
  );
}
