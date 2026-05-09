import { useTranslation } from "react-i18next";
import { useNavigate } from "@tanstack/react-router";
import { Folder, Plus, Loader2, Sparkles } from "lucide-react";

interface Folder {
  id: number; path: string; displayName: string; photoCount: number;
}
interface SidebarProps {
  folders: Folder[];
  activeFolderId: number | null;
  onSelectFolder: (id: number | null) => void;
  onAddFolder: () => void;
  onAIIndex: () => void;
  scanningFolder: string | null;
  scanProgress: string;
  totalPhotos: number;
}

export function Sidebar({
  folders, activeFolderId, onSelectFolder, onAddFolder,
  onAIIndex, scanningFolder, scanProgress, totalPhotos,
}: SidebarProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  return (
    <div className="w-[240px] bg-[#0e0f12] border-r border-[rgba(255,255,255,0.06)] flex flex-col h-full select-none">
      {/* Header */}
      <div className="px-4 py-3 border-b border-[rgba(255,255,255,0.06)]">
        <h2 className="text-[#f7f8f8] text-[14px] font-[590]">{t("appName")}</h2>
        <p className="text-[#6b6b75] text-[11px] mt-0.5">
          {t("photosCount", { count: totalPhotos.toLocaleString() })}
        </p>
      </div>

      {/* Quick Actions */}
      <div className="px-3 py-2 space-y-1">
        <button
          onClick={() => onSelectFolder(null)}
          className={`w-full text-left px-3 py-1.5 rounded-[6px] text-[13px] transition-colors ${
            activeFolderId === null
              ? "bg-[#5e6ad2]/15 text-[#5e6ad2]"
              : "text-[#a1a1aa] hover:bg-white/5 hover:text-[#f7f8f8]"
          }`}
        >
          {t("sidebarAllPhotos")}
        </button>
        <button
          onClick={onAddFolder}
          disabled={scanningFolder !== null}
          className="w-full flex items-center gap-2 px-3 py-1.5 rounded-[6px] text-[13px] text-[#a1a1aa] hover:bg-white/5 hover:text-[#f7f8f8] transition-colors disabled:opacity-50"
        >
          {scanningFolder ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Plus className="w-3.5 h-3.5" />
          )}
          {t("sidebarAddFolder")}
        </button>
        <button
          onClick={onAIIndex}
          className="w-full flex items-center gap-2 px-3 py-1.5 rounded-[6px] text-[13px] text-[#a1a1aa] hover:bg-white/5 hover:text-[#f7f8f8] transition-colors"
        >
          <Sparkles className="w-3.5 h-3.5" />
          {t("sidebarAiIndex")}
        </button>
      </div>

      {/* Scan progress */}
      {scanProgress && (
        <div className="px-3 py-1.5">
          <div className="bg-[#1c1e22] rounded-[6px] px-3 py-2">
            <p className="text-[#a1a1aa] text-[11px]">{scanProgress}</p>
            {scanningFolder && (
              <p className="text-[#6b6b75] text-[10px] truncate mt-0.5">
                {t("scanningPath", { path: scanningFolder })}
              </p>
            )}
          </div>
        </div>
      )}

      {/* Separator */}
      <div className="mx-3 my-2 border-t border-[rgba(255,255,255,0.04)]" />

      {/* Folders */}
      <div className="flex-1 overflow-y-auto px-3">
        <p className="text-[#6b6b75] text-[11px] font-[510] px-3 py-1 uppercase tracking-wider">
          {t("sidebarFolders")}
        </p>
        {folders.map((folder) => (
          <button
            key={folder.id}
            onClick={() => onSelectFolder(folder.id)}
            className={`w-full text-left px-3 py-1.5 rounded-[6px] text-[13px] transition-colors flex items-center gap-2 ${
              activeFolderId === folder.id
                ? "bg-[#5e6ad2]/15 text-[#5e6ad2]"
                : "text-[#a1a1aa] hover:bg-white/5 hover:text-[#f7f8f8]"
            }`}
          >
            <Folder className="w-3.5 h-3.5 flex-shrink-0" />
            <span className="truncate">{folder.displayName}</span>
            <span className="ml-auto text-[#6b6b75] text-[10px] tabular-nums">
              {folder.photoCount}
            </span>
          </button>
        ))}
        {folders.length === 0 && (
          <p className="text-[#6b6b75] text-[12px] px-3 py-2">{t("sidebarNoFolders")}</p>
        )}
      </div>

      {/* Footer */}
      <div className="px-3 py-2 border-t border-[rgba(255,255,255,0.04)]">
        <button
          onClick={() => navigate({ to: "/dashboard" })}
          className="w-full text-left px-3 py-1.5 rounded-[6px] text-[13px] text-[#a1a1aa] hover:bg-white/5 hover:text-[#f7f8f8] transition-colors"
        >
          📊 {t("sidebarDashboard")}
        </button>
        <button
          onClick={() => navigate({ to: "/settings" })}
          className="w-full text-left px-3 py-1.5 rounded-[6px] text-[13px] text-[#a1a1aa] hover:bg-white/5 hover:text-[#f7f8f8] transition-colors"
        >
          ⚙ {t("sidebarSettings")}
        </button>
      </div>
    </div>
  );
}
