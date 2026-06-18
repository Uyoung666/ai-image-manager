import { useLocation } from "@tanstack/react-router";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import DragWindowRegion from "@/components/drag-window-region";
import { GlobalProgressBar } from "@/components/global-progress-bar";
import { KeyboardShortcuts } from "@/components/KeyboardShortcuts";
import { OnboardingOverlay } from "@/components/onboarding/OnboardingOverlay";
import {
  OnboardingProvider,
  useOnboarding,
} from "@/components/onboarding/OnboardingProvider";
import { PerfOverlay, usePerfMonitor } from "@/components/PerfMonitor";
import { Sidebar } from "@/components/Sidebar";
import { SpotlightSearch } from "@/components/SpotlightSearch";
import { BrowseSessionProvider } from "@/contexts/BrowseSessionContext";
import { ScrollPositionProvider } from "@/contexts/ScrollPositionContext";
import {
  SidebarFilterProvider,
  useSidebarFilter,
} from "@/contexts/SidebarFilterContext";
import { useFolders } from "@/hooks/useFolders";

function isPerfMonitorEnabled() {
  try {
    return localStorage.getItem("DEV_PERF_MONITOR") === "true";
  } catch {
    return false;
  }
}

// SidebarSlot stays mounted across route changes so internal state
// (tags, expanded nodes, etc.) is preserved. Hidden via CSS on non-homepage routes.

function SidebarSlot() {
  const location = useLocation();
  const isHomePage = location.pathname === "/";
  const filter = useSidebarFilter();
  const { data: folders = [] } = useFolders();

  return (
    <div className={isHomePage ? "" : "hidden"}>
      <Sidebar
        activeFolderId={filter.activeFolderId}
        activeTagIds={filter.activeTagIds}
        collapsed={filter.collapsed}
        favoriteActive={filter.favoriteOnly}
        folders={folders}
        importPhase={filter.importPhase}
        onAddFolder={filter.handleAddFolder}
        onCancelScan={filter.handleCancelScan}
        onDeleteFolder={filter.handleDeleteFolder}
        onSelectFavorites={filter.toggleFavoritesAndNotify}
        onSelectFolder={filter.selectFolderAndNotify}
        onToggleCollapse={filter.toggleCollapsed}
        onToggleTag={filter.toggleTag}
        onToggleTagMode={filter.toggleTagMode}
        scanningFolder={filter.scanningFolder}
        scanProgress={filter.scanProgress}
        tagMode={filter.tagMode}
        totalPhotos={filter.totalPhotos}
      />
    </div>
  );
}

export default function BaseLayout({ children }: { children: ReactNode }) {
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [perfOn] = useState(isPerfMonitorEnabled);
  const { metrics, memory } = usePerfMonitor(perfOn);
  const shortcutsOpenRef = useRef(shortcutsOpen);
  shortcutsOpenRef.current = shortcutsOpen;

  // 使用 ref 读取 shortcutsOpen，避免回调依赖变化导致监听器反复重建，
  // 防止按 ? 键时多个 handler 同时触发产生叠加面板
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === "?" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const target = e.target as HTMLElement;
      if (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable
      ) {
        return;
      }
      e.preventDefault();
      setShortcutsOpen((prev) => !prev);
    }
    if (e.key === "Escape" && shortcutsOpenRef.current) {
      setShortcutsOpen(false);
    }
  }, []);

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  return (
    <ScrollPositionProvider>
      <OnboardingProvider>
        <OnboardingOverlay />
        <AppContentGate>
          <BrowseSessionProvider>
            <SidebarFilterProvider>
              <div className="flex h-screen flex-col overflow-hidden">
                <DragWindowRegion title="AI Image Manager" />
                <GlobalProgressBar />
                <div className="flex flex-1 overflow-hidden">
                  <SidebarSlot />
                  <main className="flex-1 overflow-hidden">{children}</main>
                </div>
                <SpotlightSearch />
                <KeyboardShortcuts
                  onClose={() => setShortcutsOpen(false)}
                  open={shortcutsOpen}
                />
                {perfOn && <PerfOverlay memory={memory} metrics={metrics} />}
              </div>
            </SidebarFilterProvider>
          </BrowseSessionProvider>
        </AppContentGate>
      </OnboardingProvider>
    </ScrollPositionProvider>
  );
}

/**
 * 引导期间不渲染应用内容，节省资源并避免覆盖层下视觉跳跃。
 * 退出动画期间（exiting=true）开始渲染内容，确保覆盖层淡出时下方已有应用 UI。
 */
function AppContentGate({ children }: { children: ReactNode }) {
  const { needsOnboarding, exiting } = useOnboarding();

  if (needsOnboarding && !exiting) {
    return null;
  }

  return <>{children}</>;
}
