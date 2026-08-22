import {
  installFromDialog,
  listPlugins,
  selectPluginAsset,
  setPluginEnabled,
  setPluginSettings,
  uninstallPlugin,
} from "./handlers";

export const plugins = {
  list: listPlugins,
  installFromDialog,
  setEnabled: setPluginEnabled,
  setSettings: setPluginSettings,
  selectAsset: selectPluginAsset,
  uninstall: uninstallPlugin,
};
