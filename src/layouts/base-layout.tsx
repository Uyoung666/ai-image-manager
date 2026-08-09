import { useLocation } from "@tanstack/react-router";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import DragWindowRegion from "@/components/drag-window-region";
import { GlobalProgressBar } from "@/components/global-progress-bar";
import { ImportDropLayer } from "@/components/import-drop-layer";
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
import {
  ImportDropProvider,
  useImportDropContext,
} from "@/contexts/import-drop-context";
import {
  SidebarFilterProvider,
  useSidebarFilter,
} from "@/contexts/SidebarFilterContext";
import { GlobalAiStatusProvider } from "@/hooks/use-global-ai-status";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useModalFocusTrap } from "@/hooks/use-modal-focus-trap";
import { useFolders } from "@/hooks/useFolders";
import { WanderProvider } from "@/providers/WanderProvider";

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
  const { zones } = useImportDropContext();
  const { t } = useTranslation();
  const compactViewport = useMediaQuery("(max-width: 840px)");
  const [compactOpen, setCompactOpen] = useState(false);
  const compactLayerRef = useRef<HTMLDivElement>(null);
  const effectiveCollapsed = compactViewport ? !compactOpen : filter.collapsed;

  useEffect(() => {
    if (!(compactViewport && isHomePage)) {
      setCompactOpen(false);
    }
  }, [compactViewport, isHomePage]);

  useModalFocusTrap({
    active: isHomePage && compactViewport && compactOpen,
    containerRef: compactLayerRef,
    onEscape: () => setCompactOpen(false),
  });

  const closeCompactSidebar = () => {
    if (compactViewport) {
      setCompactOpen(false);
    }
  };

  return (
    <>
      {isHomePage && compactViewport && compactOpen && (
        <button
          aria-label={t("close")}
          className="compact-sidebar-backdrop"
          onClick={() => setCompactOpen(false)}
          type="button"
        />
      )}
      <div
        aria-label={
          isHomePage && compactViewport && compactOpen
            ? t("sidebarFolders")
            : undefined
        }
        aria-modal={
          isHomePage && compactViewport && compactOpen ? true : undefined
        }
        className={
          isHomePage
            ? `compact-sidebar-layer relative h-full shrink-0 ${
                compactViewport && compactOpen ? "is-open" : ""
              }`
            : "hidden"
        }
        ref={compactLayerRef}
        role={
          isHomePage && compactViewport && compactOpen ? "dialog" : undefined
        }
      >
        <Sidebar
          activeFolderId={filter.activeFolderId}
          activeTagIds={filter.activeTagIds}
          collapsed={effectiveCollapsed}
          favoriteActive={filter.favoriteOnly}
          folders={folders}
          onAddFolder={filter.handleAddFolder}
          onDeleteFolder={filter.handleDeleteFolder}
          onSelectAllPhotos={() => {
            filter.selectAllPhotos();
            closeCompactSidebar();
          }}
          onSelectFavorites={() => {
            filter.toggleFavorites();
            closeCompactSidebar();
          }}
          onSelectFolder={(folderId) => {
            filter.selectFolder(folderId);
            closeCompactSidebar();
          }}
          onToggleCollapse={
            compactViewport
              ? () => setCompactOpen((previous) => !previous)
              : filter.toggleCollapsed
          }
          onToggleTag={filter.toggleTag}
          onToggleTagMode={filter.toggleTagMode}
          tagMode={filter.tagMode}
          totalPhotos={filter.totalPhotos}
        />
        {isHomePage && (
          <ImportDropLayer
            className={`sidebar-import-drop-layer ${effectiveCollapsed ? "is-collapsed" : ""}`}
            kind={zones.dragKind}
            onDragOver={zones.handleZoneDragOver}
            onDrop={zones.handleZoneDrop}
            zone="folders"
          />
        )}
      </div>
    </>
  );
}

export default function BaseLayout({ children }: { children: ReactNode }) {
  return (
    <ImportDropProvider>
      <BaseLayoutContent>{children}</BaseLayoutContent>
    </ImportDropProvider>
  );
}

function BaseLayoutContent({ children }: { children: ReactNode }) {
  const location = useLocation();
  const isHomePage = location.pathname === "/";
  const { zones } = useImportDropContext();
  const { t } = useTranslation();
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
    <OnboardingProvider>
      <GlobalAiStatusProvider>
        <WanderProvider>
          <OnboardingOverlay />
          <AppContentGate>
            <BrowseSessionProvider>
              <SidebarFilterProvider>
                {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: the application shell owns the native external drag lifecycle */}
                <div
                  aria-label={t("appName")}
                  className={`relative flex h-screen flex-col overflow-hidden ${
                    isHomePage
                      ? `home-workspace ${zones.dragKind ? "home-import-dragging" : ""}`
                      : ""
                  }`}
                  onDragEnter={isHomePage ? zones.handleRootDragEnter : undefined}
                  onDragLeave={isHomePage ? zones.handleRootDragLeave : undefined}
                  onDragOver={isHomePage ? zones.handleRootDragOver : undefined}
                  onDrop={isHomePage ? zones.handleRootDrop : undefined}
                  role="application"
                >
                  <DragWindowRegion title="AI Image Manager" />
                  <GlobalProgressBar />
                  <div
                    className={`relative flex min-h-0 flex-1 overflow-hidden ${
                      isHomePage ? "home-workspace-content" : ""
                    }`}
                  >
                    <SidebarSlot />
                    <main
                      className={`min-w-0 flex-1 overflow-hidden ${
                        isHomePage ? "home-gallery-canvas relative" : ""
                      }`}
                    >
                      {children}
                      {isHomePage && (
                        <ImportDropLayer
                          className="home-import-drop-layer"
                          kind={zones.dragKind}
                          onDragOver={zones.handleZoneDragOver}
                          onDrop={zones.handleZoneDrop}
                          zone="image"
                        />
                      )}
                    </main>
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
        </WanderProvider>
      </GlobalAiStatusProvider>
    </OnboardingProvider>
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
