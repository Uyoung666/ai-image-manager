import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NebulaGlassPlugin } from "@/plugins/builtins/nebula-glass";
import { NEBULA_GLASS_PLUGIN_ID } from "@/plugins/builtins/nebula-glass-manifest";
import {
  PluginBackdropHost,
  PluginHostProvider,
  usePluginHost,
} from "@/plugins/runtime";
import type { NormalizedPluginManifestV2 } from "@/plugins/types";

const mocks = vi.hoisted(() => ({
  listPlugins: vi.fn(),
  reloadDevPlugin: vi.fn(),
  revalidateAppLocale: vi.fn().mockResolvedValue(null),
  reportPluginActivationResult: vi.fn().mockResolvedValue(undefined),
  setPluginEnabled: vi.fn(),
}));
const { listPlugins, setPluginEnabled } = mocks;

vi.mock("@/actions/plugins", () => ({
  commitPluginInstall: vi.fn(),
  discardPluginInspection: vi.fn(),
  inspectPluginFromDialog: vi.fn(),
  installPluginFromDialog: vi.fn(),
  listPlugins: mocks.listPlugins,
  loadDevDirectoryFromDialog: vi.fn(),
  reloadDevPlugin: mocks.reloadDevPlugin,
  reportPluginActivationResult: mocks.reportPluginActivationResult,
  removeDevPlugin: vi.fn(),
  removePluginAsset: vi.fn(),
  resetPluginSettings: vi.fn(),
  selectPluginAsset: vi.fn(),
  setPluginDeveloperMode: vi.fn(),
  setPluginEnabled: mocks.setPluginEnabled,
  setPluginSettings: vi.fn(),
  uninstallPlugin: vi.fn(),
}));

vi.mock("@/actions/localization", () => ({
  revalidateAppLocale: mocks.revalidateAppLocale,
}));

const activeManifest: NormalizedPluginManifestV2 = {
  apiVersion: 2,
  author: { name: "Active" },
  capabilities: ["theme"],
  description: { en: "Active", zh: "启用" },
  engine: { minAppVersion: "2.0.0" },
  id: "com.example.active",
  manifestVersion: 2,
  name: { en: "Active", zh: "启用" },
  settingGroups: [],
  settings: [],
  theme: {
    layers: [{ color: "#112233", id: "active-layer", type: "solid" }],
  },
  themeFile: "theme.json",
  version: "1.0.0",
};

const previewManifest: NormalizedPluginManifestV2 = {
  ...activeManifest,
  description: { en: "Preview", zh: "预览" },
  id: "com.example.preview",
  name: { en: "Preview", zh: "预览" },
  theme: {
    layers: [{ color: "#aabbcc", id: "preview-layer", type: "solid" }],
  },
};

function record(
  manifest: NormalizedPluginManifestV2,
  status: "active" | "disabled"
) {
  return {
    assetUrls: {},
    enabled: status === "active",
    manifest,
    settings: {},
    source: "local" as const,
    status,
  };
}

function Controls() {
  const host = usePluginHost();
  return (
    <div>
      <button
        onClick={() => host.previewPlugin("com.example.preview")}
        type="button"
      >
        preview
      </button>
      <button onClick={host.exitPreview} type="button">
        exit
      </button>
      <button onClick={() => host.enable("com.example.preview")} type="button">
        enable
      </button>
      <button
        onClick={() => host.reloadDeveloperPlugin("com.example.active")}
        type="button"
      >
        reload locale
      </button>
      <output data-testid="active">
        {host.activePlugin?.manifest.id ?? ""}
      </output>
      <output data-testid="preview">{host.previewId ?? ""}</output>
    </div>
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
  document.documentElement.removeAttribute("data-active-plugin");
});

describe("plugin runtime preview host", () => {
  it("renders a transient preview while keeping the active plugin and cache unchanged", async () => {
    const active = record(activeManifest, "active");
    const preview = record(previewManifest, "disabled");
    listPlugins.mockResolvedValue({ plugins: [active, preview] });

    render(
      <PluginHostProvider>
        <PluginBackdropHost />
        <Controls />
      </PluginHostProvider>
    );

    await waitFor(() =>
      expect(screen.getByTestId("active")).toHaveTextContent(activeManifest.id)
    );
    expect(
      document.querySelector('[data-plugin-theme-layer="active-layer"]')
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(mocks.reportPluginActivationResult).toHaveBeenCalledWith(
        activeManifest.id,
        activeManifest.version,
        true
      )
    );
    fireEvent.click(screen.getByRole("button", { name: "preview" }));
    await waitFor(() =>
      expect(screen.getByTestId("preview")).toHaveTextContent(
        previewManifest.id
      )
    );
    expect(
      document.querySelector('[data-plugin-theme-layer="preview-layer"]')
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(mocks.reportPluginActivationResult).toHaveBeenCalledWith(
        previewManifest.id,
        previewManifest.version,
        true
      )
    );
    expect(screen.getByTestId("active")).toHaveTextContent(activeManifest.id);
    expect(localStorage.getItem("plugins.active")).toBe(activeManifest.id);

    fireEvent.click(screen.getByRole("button", { name: "exit" }));
    await waitFor(() =>
      expect(screen.getByTestId("preview")).toHaveTextContent("")
    );
    expect(
      document.querySelector('[data-plugin-theme-layer="active-layer"]')
    ).toBeInTheDocument();
  });

  it("formalizes activation when enabling the previewed plugin and exits preview", async () => {
    const active = record(activeManifest, "active");
    const preview = record(previewManifest, "disabled");
    const enabledPreview = record(previewManifest, "active");
    const disabledActive = {
      ...active,
      enabled: false,
      status: "disabled" as const,
    };
    listPlugins.mockResolvedValue({ plugins: [active, preview] });
    setPluginEnabled.mockResolvedValue({
      plugins: [disabledActive, enabledPreview],
    });

    render(
      <PluginHostProvider>
        <PluginBackdropHost />
        <Controls />
      </PluginHostProvider>
    );
    await waitFor(() =>
      expect(screen.getByTestId("active")).toHaveTextContent(activeManifest.id)
    );
    fireEvent.click(screen.getByRole("button", { name: "preview" }));
    await waitFor(() =>
      expect(screen.getByTestId("preview")).toHaveTextContent(
        previewManifest.id
      )
    );
    fireEvent.click(screen.getByRole("button", { name: "enable" }));
    await waitFor(() => {
      expect(screen.getByTestId("active")).toHaveTextContent(
        previewManifest.id
      );
      expect(screen.getByTestId("preview")).toHaveTextContent("");
    });
    expect(setPluginEnabled).toHaveBeenCalledWith(previewManifest.id, true);
  });

  it("does not preview an incompatible plugin", async () => {
    const active = record(activeManifest, "active");
    const incompatible = {
      ...record(previewManifest, "disabled"),
      status: "incompatible" as const,
    };
    listPlugins.mockResolvedValue({ plugins: [active, incompatible] });

    render(
      <PluginHostProvider>
        <PluginBackdropHost />
        <Controls />
      </PluginHostProvider>
    );
    await waitFor(() =>
      expect(screen.getByTestId("active")).toHaveTextContent(activeManifest.id)
    );
    fireEvent.click(screen.getByRole("button", { name: "preview" }));
    expect(screen.getByTestId("preview")).toHaveTextContent("");
    expect(
      document.querySelector('[data-plugin-theme-layer="active-layer"]')
    ).toBeInTheDocument();
  });

  it("reapplies the renderer locale after a locale-affecting plugin mutation", async () => {
    const active = record(activeManifest, "active");
    const snapshot = { plugins: [active] };
    listPlugins.mockResolvedValue(snapshot);
    mocks.reloadDevPlugin.mockResolvedValue(snapshot);

    render(
      <PluginHostProvider>
        <Controls />
      </PluginHostProvider>
    );

    await waitFor(() =>
      expect(screen.getByTestId("active")).toHaveTextContent(activeManifest.id)
    );
    fireEvent.click(screen.getByRole("button", { name: "reload locale" }));

    await waitFor(() => {
      expect(mocks.reloadDevPlugin).toHaveBeenCalledWith(activeManifest.id);
      expect(mocks.revalidateAppLocale).toHaveBeenCalledTimes(1);
    });
  });

  it("reports local activation failures and applies the returned snapshot", async () => {
    const failingManifest = {
      ...activeManifest,
      id: NEBULA_GLASS_PLUGIN_ID,
      name: { en: "Nebula Glass", zh: "星云玻璃" },
    };
    const failing = record(failingManifest, "active");
    const failureSnapshot = { plugins: [] };
    listPlugins.mockResolvedValue({ plugins: [failing] });
    mocks.reportPluginActivationResult.mockResolvedValueOnce(failureSnapshot);
    const activateSpy = vi
      .spyOn(NebulaGlassPlugin, "activate")
      .mockImplementation(() => {
        throw new Error("activation boom");
      });

    render(
      <PluginHostProvider>
        <Controls />
      </PluginHostProvider>
    );

    await waitFor(() =>
      expect(mocks.reportPluginActivationResult).toHaveBeenCalledWith(
        NEBULA_GLASS_PLUGIN_ID,
        failingManifest.version,
        false,
        "activation-failed",
        "activation boom"
      )
    );
    await waitFor(() =>
      expect(screen.getByTestId("active")).toHaveTextContent("")
    );
    expect(setPluginEnabled).not.toHaveBeenCalled();
    activateSpy.mockRestore();
  });
});
