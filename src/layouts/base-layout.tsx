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
import { WanderProvider } from "@/providers/WanderProvider";
import {
  SidebarFilterProvider,
  useSidebarFilter,
} from "@/contexts/SidebarFilterContext";
import { useFolders } from "@/hooks/useFolders";
import { GlobalAiStatusProvider } from "@/hooks/use-global-ai-status";

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
        onAddFolder={filter.handleAddFolder}
        onDeleteFolder={filter.handleDeleteFolder}
        onSelectAllPhotos={filter.selectAllPhotos}
        onSelectFavorites={filter.toggleFavorites}
        onSelectFolder={filter.selectFolder}
        onToggleCollapse={filter.toggleCollapsed}
        onToggleTag={filter.toggleTag}
        onToggleTagMode={filter.toggleTagMode}
        tagMode={filter.tagMode}
        totalPhotos={filter.totalPhotos}
      />
    </div>
  );
}

export default function BaseLayout({ children }: { children: ReactNode }) {
  const location = useLocation();
  const isHomePage = location.pathname === "/";
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
      e.stopImmediatePropagation();
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
        <GlobalAiStatusProvider>
          <WanderProvider>
            <OnboardingOverlay />
            <AppContentGate>
              <BrowseSessionProvider>
                <SidebarFilterProvider>
                  <div
                    className={`flex h-screen flex-col overflow-hidden ${
                      isHomePage ? "home-workspace" : ""
                    }`}
                  >
                    <DragWindowRegion title="AI Image Manager" />
                    <GlobalProgressBar />
                    <div
                      className={`flex min-h-0 flex-1 overflow-hidden ${
                        isHomePage ? "home-workspace-content" : ""
                      }`}
                    >
                      <SidebarSlot />
                      <main
                        className={`min-w-0 flex-1 overflow-hidden ${
                          isHomePage ? "home-gallery-canvas" : ""
                        }`}
                      >
                        {children}
                      </main>
                    </div>
                    <SpotlightSearch />
                    <KeyboardShortcuts
                      onClose={() => setShortcutsOpen(false)}
                      open={shortcutsOpen}
                    />
                    {perfOn && (
                      <PerfOverlay memory={memory} metrics={metrics} />
                    )}
                  </div>
                </SidebarFilterProvider>
              </BrowseSessionProvider>
            </AppContentGate>
          </WanderProvider>
        </GlobalAiStatusProvider>
      </OnboardingProvider>
    </ScrollPositionProvider>
  );
}

/**
 * 幕布模式：引导期间应用内容预渲染在遮罩后方。
 * - preRenderContent（Step 3 显示时）：DOM 已挂载但 invisible，遮罩 z-[100] 完全覆盖
 * - exiting（点击完成后）：移除 invisible，遮罩淡出 400ms 露出已就绪的内容
 * - wrapper 始终为同一 DOM 节点，避免 React 重新挂载子组件树
 */
function AppContentGate({ children }: { children: ReactNode }) {
  const { needsOnboarding, exiting, preRenderContent } = useOnboarding();

  if (needsOnboarding && !exiting && !preRenderContent) {
    return null;
  }

  return (
    <div className={preRenderContent && !exiting ? "invisible" : ""}>
      {children}
    </div>
  );
}
