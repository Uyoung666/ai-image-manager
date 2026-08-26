import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PluginManagerView } from "@/components/plugins/plugin-manager-view";
import type { PluginManifestV2 } from "@/plugins/types";

const manifest: PluginManifestV2 = {
  apiVersion: 2,
  author: { name: "Test author" },
  capabilities: ["theme"],
  description: { en: "A test theme", zh: "测试主题" },
  engine: { minAppVersion: "2.0.0" },
  id: "com.example.test-theme",
  manifestVersion: 2,
  name: { en: "Test theme", zh: "测试主题" },
  settingGroups: [],
  settings: [],
  themeFile: "theme.json",
  version: "1.2.0",
};

const plugin = {
  assetUrls: {},
  enabled: false,
  manifest,
  settings: {},
  source: "local" as const,
  status: "disabled" as const,
};

const developerPlugin = {
  ...plugin,
  source: "dev" as const,
};

function renderView(
  overrides: Partial<React.ComponentProps<typeof PluginManagerView>> = {}
) {
  return render(
    <PluginManagerView
      activeId={null}
      onCancelInstall={vi.fn()}
      onConfirmInstall={vi.fn()}
      onDeveloperModeChange={vi.fn()}
      onExitPreview={vi.fn()}
      onLoadDeveloperDirectory={vi.fn()}
      onPreviewPlugin={vi.fn()}
      onRefresh={vi.fn()}
      onSelectPlugin={vi.fn()}
      onTogglePlugin={vi.fn()}
      onUninstallPlugin={vi.fn()}
      plugins={[plugin]}
      previewId={null}
      selectedId={plugin.manifest.id}
      settingsPanel={<div>settings panel</div>}
      {...overrides}
    />
  );
}

describe("PluginManagerView", () => {
  it("keeps selecting a card separate from enabling its switch", () => {
    const onSelectPlugin = vi.fn();
    const onTogglePlugin = vi.fn();
    renderView({ onSelectPlugin, onTogglePlugin, selectedId: null });

    fireEvent.click(screen.getByTestId(`plugin-card-${plugin.manifest.id}`));
    expect(onSelectPlugin).toHaveBeenCalledWith(plugin.manifest.id);
    expect(onTogglePlugin).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("checkbox", { name: "pluginManagerToggle: 测试主题" })
    );
    expect(onTogglePlugin).toHaveBeenCalledWith(plugin.manifest.id, true);
  });

  it("uses controlled preview state and exposes preview exit", () => {
    const onPreviewPlugin = vi.fn();
    const onExitPreview = vi.fn();
    const view = renderView({ onExitPreview, onPreviewPlugin });

    fireEvent.click(
      screen.getByRole("button", { name: "pluginManagerPreview: 测试主题" })
    );
    expect(onPreviewPlugin).toHaveBeenCalledWith(plugin.manifest.id);

    view.rerender(
      <PluginManagerView
        activeId={null}
        onExitPreview={onExitPreview}
        onPreviewPlugin={onPreviewPlugin}
        plugins={[plugin]}
        previewId={plugin.manifest.id}
        selectedId={plugin.manifest.id}
      />
    );
    expect(screen.getByTestId("preview-banner")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "pluginManagerExitPreview" })
    );
    expect(onExitPreview).toHaveBeenCalledTimes(1);
  });

  it("blocks preview for incompatible plugins", () => {
    renderView({
      plugins: [{ ...plugin, status: "incompatible" }],
    });

    expect(
      screen.getByRole("button", {
        name: "pluginManagerPreview: 测试主题",
      })
    ).toBeDisabled();
  });

  it("shows install preflight metadata and confirms installation", () => {
    const onConfirmInstall = vi.fn();
    const preview = {
      checksum: "0123456789abcdef0123456789abcdef",
      compatible: true,
      existingVersion: "1.1.0",
      manifest,
      packageSize: 2048,
      relation: "upgrade",
      signed: false,
    };
    renderView({ installPreview: preview, onConfirmInstall });

    expect(screen.getByRole("dialog")).toHaveTextContent(
      "pluginManagerPackageSize"
    );
    expect(
      screen.getByText("pluginManagerUnsignedWarning")
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "pluginManagerInstallConfirm" })
    );
    expect(onConfirmInstall).toHaveBeenCalledWith(preview);
  });

  it("accepts the service install-preview DTO without mapping", () => {
    const onConfirmInstall = vi.fn();
    const preview = {
      capabilities: ["theme"],
      checksum: "fedcba9876543210fedcba9876543210",
      compatible: true,
      currentVersion: "1.1.0",
      kind: "update" as const,
      manifest,
      packageBytes: 4096,
      pluginId: manifest.id,
      source: "dialog" as const,
      token: "stage-token",
      trust: "user-selected" as const,
      version: manifest.version,
    };
    renderView({ installPreview: preview, onConfirmInstall });

    expect(screen.getByRole("dialog")).toHaveTextContent("4.0 KB");
    expect(screen.getByText("pluginManagerInstallUpgrade")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "pluginManagerInstallConfirm" })
    );
    expect(onConfirmInstall).toHaveBeenCalledWith(preview);
  });

  it("passes the remove-data choice to uninstall", () => {
    const onUninstallPlugin = vi.fn();
    renderView({ onUninstallPlugin });

    fireEvent.click(
      screen.getByRole("button", { name: "pluginManagerUninstall: 测试主题" })
    );
    const removeData = screen.getByRole("checkbox", {
      name: "pluginManagerRemoveData",
    });
    expect(removeData).toBeChecked();
    fireEvent.click(removeData);
    expect(removeData).not.toBeChecked();
    fireEvent.click(
      screen.getByRole("button", { name: "pluginManagerUninstallConfirm" })
    );
    expect(onUninstallPlugin).toHaveBeenCalledWith(plugin.manifest.id, false);
    fireEvent.click(
      screen.getByRole("button", { name: "pluginManagerUninstall: 测试主题" })
    );
    expect(
      screen.getByRole("checkbox", { name: "pluginManagerRemoveData" })
    ).toBeChecked();
  });

  it("shows reload and remove actions for developer-directory plugins", () => {
    const onReloadDeveloperPlugin = vi.fn();
    const onRemoveDeveloperPlugin = vi.fn();
    renderView({
      onReloadDeveloperPlugin,
      onRemoveDeveloperPlugin,
      plugins: [developerPlugin],
      selectedId: developerPlugin.manifest.id,
    });

    fireEvent.click(
      screen.getByRole("button", {
        name: "pluginManagerReloadDeveloper: 测试主题",
      })
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "pluginManagerRemoveDeveloper: 测试主题",
      })
    );
    expect(onReloadDeveloperPlugin).toHaveBeenCalledWith(
      developerPlugin.manifest.id
    );
    expect(onRemoveDeveloperPlugin).toHaveBeenCalledWith(
      developerPlugin.manifest.id
    );
    expect(
      screen.queryByRole("button", {
        name: "pluginManagerUninstall: 测试主题",
      })
    ).not.toBeInTheDocument();
  });

  it("exposes developer controls and responsive layout semantics", () => {
    const onDeveloperModeChange = vi.fn();
    const onLoadDeveloperDirectory = vi.fn();
    const onRefresh = vi.fn();
    const view = renderView({
      developerMode: false,
      onDeveloperModeChange,
      onLoadDeveloperDirectory,
      onRefresh,
    });
    const root = screen.getByTestId("plugin-manager-view");
    expect(root).toHaveClass("overflow-x-hidden");
    expect(screen.getByTestId("plugin-manager-columns")).toHaveClass(
      "min-[900px]:grid-cols-[minmax(18rem,0.85fr)_minmax(0,1.4fr)]"
    );
    const developerModeControl = document.querySelector<HTMLElement>(
      '[data-plugin-manager-developer-mode="true"]'
    );
    expect(developerModeControl).toBeInTheDocument();
    expect(developerModeControl).toHaveClass("justify-self-end");
    expect(
      screen
        .getByRole("checkbox", { name: "pluginManagerDeveloperMode" })
        .closest('[data-plugin-manager-developer-mode="true"]')
    ).toBe(developerModeControl);
    expect(
      screen.queryByRole("button", { name: "pluginManagerLoadDirectory" })
    ).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("checkbox", { name: "pluginManagerDeveloperMode" })
    );
    expect(onDeveloperModeChange).toHaveBeenCalledWith(true);

    view.rerender(
      <PluginManagerView
        activeId={null}
        developerMode
        onDeveloperModeChange={onDeveloperModeChange}
        onLoadDeveloperDirectory={onLoadDeveloperDirectory}
        onRefresh={onRefresh}
        plugins={[plugin]}
        previewId={null}
        selectedId={plugin.manifest.id}
      />
    );
    expect(
      document.querySelector('[data-plugin-manager-developer-mode="true"]')
    ).toBe(developerModeControl);
    expect(
      screen.getByRole("button", { name: "pluginManagerLoadDirectory" })
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "pluginManagerLoadDirectory" })
    );
    fireEvent.click(
      screen.getByRole("button", { name: "pluginManagerRefresh" })
    );
    expect(onLoadDeveloperDirectory).toHaveBeenCalledTimes(1);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});
