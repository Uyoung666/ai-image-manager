import { os } from "@orpc/server";
import { z } from "zod";
import {
  getPluginManager,
  validatePluginAssetInput,
  validatePluginPatch,
} from "@/services/plugin-manager";

export const listPlugins = os.handler(() => {
  return getPluginManager().list();
});

export const installFromDialog = os.handler(() => {
  return getPluginManager().installFromDialog();
});

export const setPluginEnabled = os
  .input(z.object({ enabled: z.boolean(), pluginId: z.string() }))
  .handler(({ input }) => {
    return getPluginManager().setEnabled(input.pluginId, input.enabled);
  });

export const setPluginSettings = os
  .input(
    z.object({
      pluginId: z.string(),
      settings: z.record(
        z.string(),
        z.union([z.boolean(), z.number(), z.string()])
      ),
    })
  )
  .handler(({ input }) => {
    const parsed = validatePluginPatch(input);
    return getPluginManager().setSettings(parsed.pluginId, parsed.settings);
  });

export const selectPluginAsset = os
  .input(z.object({ pluginId: z.string(), settingId: z.string() }))
  .handler(({ input }) => {
    const parsed = validatePluginAssetInput(input);
    return getPluginManager().selectAsset(parsed.pluginId, parsed.settingId);
  });

export const uninstallPlugin = os
  .input(z.object({ pluginId: z.string() }))
  .handler(({ input }) => {
    return getPluginManager().uninstall(input.pluginId);
  });
