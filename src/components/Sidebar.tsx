import { useNavigate } from "@tanstack/react-router";
import { Folder, Loader2, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { AiProgressBar } from "./AiProgressBar";

interface FolderInfo {
  displayName: string;
  id: number;
  path: string;
  photoCount: number;
}
interface SidebarProps {
  activeFolderId: number | null;
  folders: FolderInfo[];
  onAddFolder: () => void;
  onSelectFolder: (id: number | null) => void;
  scanningFolder: string | null;
  scanProgress: string;
  totalPhotos: number;
}

export function Sidebar({
  folders,
  activeFolderId,
  onSelectFolder,
  onAddFolder,
  scanningFolder,
  scanProgress,
  totalPhotos,
}: SidebarProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  return (
    <div className="flex h-full w-[240px] select-none flex-col border-border border-r bg-secondary">
      {/* Header */}
      <div className="border-border border-b px-4 py-3">
        <h2 className="font-[590] text-foreground text-[14px]">
          {t("appName")}
        </h2>
        <p className="mt-0.5 text-[#6b6b75] text-[11px]">
          {t("photosCount", { count: totalPhotos.toLocaleString() })}
        </p>
      </div>

      {/* Quick Actions */}
      <div className="space-y-1 px-3 py-2">
        <button
          className={`w-full rounded-[6px] px-3 py-1.5 text-left text-[13px] transition-colors ${
            activeFolderId === null
              ? "bg-primary/15 text-primary"
              : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
          }`}
          onClick={() => onSelectFolder(null)}
        >
          {t("sidebarAllPhotos")}
        </button>
        <button
          className="flex w-full items-center gap-2 rounded-[6px] px-3 py-1.5 text-muted-foreground text-[13px] transition-colors hover:bg-foreground/5 hover:text-foreground disabled:opacity-50"
          disabled={scanningFolder !== null}
          onClick={onAddFolder}
        >
          {scanningFolder ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Plus className="h-3.5 w-3.5" />
          )}
          {t("sidebarAddFolder")}
        </button>
        <AiProgressBar />
      </div>

      {/* Scan progress */}
      {scanProgress && (
        <div className="px-3 py-1.5">
          <div className="rounded-[6px] bg-card px-3 py-2">
            <p className="text-muted-foreground text-[11px]">{scanProgress}</p>
            {scanningFolder && (
              <p className="mt-0.5 truncate text-[#6b6b75] text-[10px]">
                {t("scanningPath", { path: scanningFolder })}
              </p>
            )}
          </div>
        </div>
      )}

      {/* Separator */}
      <div className="mx-3 my-2 border-border border-t" />

      {/* Folders */}
      <div className="flex-1 overflow-y-auto px-3">
        <p className="px-3 py-1 font-[510] text-[#6b6b75] text-[11px] uppercase tracking-wider">
          {t("sidebarFolders")}
        </p>
        {folders.map((folder) => (
          <button
            className={`flex w-full items-center gap-2 rounded-[6px] px-3 py-1.5 text-left text-[13px] transition-colors ${
              activeFolderId === folder.id
                ? "bg-primary/15 text-primary"
                : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
            }`}
            key={folder.id}
            onClick={() => onSelectFolder(folder.id)}
          >
            <Folder className="h-3.5 w-3.5 flex-shrink-0" />
            <span className="truncate">{folder.displayName}</span>
            <span className="ml-auto text-[#6b6b75] text-[10px] tabular-nums">
              {folder.photoCount}
            </span>
          </button>
        ))}
        {folders.length === 0 && (
          <p className="px-3 py-2 text-[#6b6b75] text-[12px]">
            {t("sidebarNoFolders")}
          </p>
        )}
      </div>

      {/* Footer */}
      <div className="border-border border-t px-3 py-2">
        <button
          className="w-full rounded-[6px] px-3 py-1.5 text-left text-muted-foreground text-[13px] transition-colors hover:bg-foreground/5 hover:text-foreground"
          onClick={() => navigate({ to: "/dashboard" })}
        >
          ⚙ {t("sidebarDashboard")}
        </button>
        <button
          className="w-full rounded-[6px] px-3 py-1.5 text-left text-muted-foreground text-[13px] transition-colors hover:bg-foreground/5 hover:text-foreground"
          onClick={() => navigate({ to: "/duplicates" })}
        >
          ⟲ 重复照片检测
        </button>
        <button
          className="w-full rounded-[6px] px-3 py-1.5 text-left text-muted-foreground text-[13px] transition-colors hover:bg-foreground/5 hover:text-foreground"
          onClick={() => navigate({ to: "/settings" })}
        >
          ⚙ {t("sidebarSettings")}
        </button>
      </div>
    </div>
  );
}
