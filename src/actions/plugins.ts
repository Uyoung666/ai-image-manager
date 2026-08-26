import { ipc } from "@/ipc/manager";

export const listPlugins = () => ipc.client.plugins.list();

export const installPluginFromDialog = () =>
  ipc.client.plugins.installFromDialog();

export const inspectPluginFromDialog = () =>
  ipc.client.plugins.inspectFromDialog();

export const commitPluginInstall = (token: string) =>
  ipc.client.plugins.commitInstall({ token });

export const discardPluginInspection = (token: string) =>
  ipc.client.plugins.discardInspection({ token });

export const reportPluginActivationResult = (
  pluginId: string,
  version: string,
  success: boolean,
  errorCode?: string,
  errorDetail?: string
) =>
  ipc.client.plugins.reportActivationResult({
    errorCode,
    errorDetail,
    pluginId,
    success,
    version,
  });

export const setPluginEnabled = (pluginId: string, enabled: boolean) =>
  ipc.client.plugins.setEnabled({ enabled, pluginId });

export const setPluginSettings = (
  pluginId: string,
  settings: Record<string, boolean | number | string | null>
) => ipc.client.plugins.setSettings({ pluginId, settings });

export const selectPluginAsset = (pluginId: string, settingId: string) =>
  ipc.client.plugins.selectAsset({ pluginId, settingId });

export const removePluginAsset = (pluginId: string, settingId: string) =>
  ipc.client.plugins.removeAsset({ pluginId, settingId });

export const resetPluginSettings = (pluginId: string, settingIds?: string[]) =>
  ipc.client.plugins.resetSettings({ pluginId, settingIds });

export const uninstallPlugin = (pluginId: string, removeData = true) =>
  ipc.client.plugins.uninstall({ pluginId, removeData });

export const setPluginDeveloperMode = (enabled: boolean) =>
  ipc.client.plugins.setDeveloperMode({ enabled });

export const loadDevDirectoryFromDialog = () =>
  ipc.client.plugins.loadDevDirectoryFromDialog();

export const reloadDevPlugin = (pluginId: string) =>
  ipc.client.plugins.reloadDevPlugin({ pluginId });

export const removeDevPlugin = (pluginId: string) =>
  ipc.client.plugins.removeDevPlugin({ pluginId });

// Keep action names aligned with the typed IPC surface for callers that do
// not use the more descriptive renderer-facing aliases above.
export const list = listPlugins;
export const installFromDialog = installPluginFromDialog;
export const inspectFromDialog = inspectPluginFromDialog;
export const commitInstall = commitPluginInstall;
export const discardInspection = discardPluginInspection;
export const reportActivationResult = reportPluginActivationResult;
export const setEnabled = setPluginEnabled;
export const setSettings = setPluginSettings;
export const selectAsset = selectPluginAsset;
export const removeAsset = removePluginAsset;
export const resetSettings = resetPluginSettings;
export const uninstall = uninstallPlugin;
export const setDeveloperMode = setPluginDeveloperMode;
