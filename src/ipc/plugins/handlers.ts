import { os } from "@orpc/server";
import { z } from "zod";
import {
  getPluginManager,
  validatePluginAssetInput,
  validatePluginPatch,
} from "@/services/plugin-manager";

const pluginIdSchema = z.string().min(1).max(160);
const settingIdSchema = z.string().min(1).max(160);
const tokenSchema = z.string().min(1).max(160);
const versionSchema = z.string().min(1).max(80);
const settingsSchema = z.record(
  z.string().min(1).max(160),
  z.union([z.boolean(), z.number(), z.string(), z.null()])
);

export const listPlugins = os.handler(() => {
  return getPluginManager().list();
});

export const installFromDialog = os.handler(() => {
  return getPluginManager().installFromDialog();
});

export const setPluginEnabled = os
  .input(z.object({ enabled: z.boolean(), pluginId: pluginIdSchema }).strict())
  .handler(({ input }) => {
    return getPluginManager().setEnabled(input.pluginId, input.enabled);
  });

export const setPluginSettings = os
  .input(
    z
      .object({
        pluginId: pluginIdSchema,
        settings: settingsSchema,
      })
      .strict()
  )
  .handler(({ input }) => {
    const parsed = validatePluginPatch(input);
    return getPluginManager().setSettings(parsed.pluginId, parsed.settings);
  });

export const selectPluginAsset = os
  .input(
    z.object({ pluginId: pluginIdSchema, settingId: settingIdSchema }).strict()
  )
  .handler(({ input }) => {
    const parsed = validatePluginAssetInput(input);
    return getPluginManager().selectAsset(parsed.pluginId, parsed.settingId);
  });

export const uninstallPlugin = os
  .input(
    z
      .object({ pluginId: pluginIdSchema, removeData: z.boolean().optional() })
      .strict()
  )
  .handler(({ input }) => {
    return getPluginManager().uninstall(
      input.pluginId,
      input.removeData ?? true
    );
  });

export const inspectFromDialog = os.handler(() =>
  getPluginManager().inspectFromDialog()
);

export const commitInstall = os
  .input(z.object({ token: tokenSchema }).strict())
  .handler(({ input }) => getPluginManager().commitInstall(input.token));

export const discardInspection = os
  .input(z.object({ token: tokenSchema }).strict())
  .handler(({ input }) => getPluginManager().discardInspection(input.token));

export const reportPluginActivationResult = os
  .input(
    z
      .object({
        errorCode: z.string().min(1).max(80).optional(),
        errorDetail: z.string().max(240).optional(),
        pluginId: pluginIdSchema,
        success: z.boolean(),
        version: versionSchema,
      })
      .strict()
  )
  .handler(({ input }) =>
    getPluginManager().reportActivationResult(
      input.pluginId,
      input.version,
      input.success,
      input.errorCode,
      input.errorDetail
    )
  );

export const removePluginAsset = os
  .input(
    z.object({ pluginId: pluginIdSchema, settingId: settingIdSchema }).strict()
  )
  .handler(({ input }) =>
    getPluginManager().removeAsset(input.pluginId, input.settingId)
  );

export const resetPluginSettings = os
  .input(
    z
      .object({
        pluginId: pluginIdSchema,
        settingIds: z.array(settingIdSchema).max(256).optional(),
      })
      .strict()
  )
  .handler(({ input }) =>
    getPluginManager().resetSettings(input.pluginId, input.settingIds)
  );

export const setPluginDeveloperMode = os
  .input(z.object({ enabled: z.boolean() }).strict())
  .handler(({ input }) => getPluginManager().setDeveloperMode(input.enabled));

export const loadDevDirectoryFromDialog = os.handler(() =>
  getPluginManager().loadDevDirectoryFromDialog()
);

export const reloadDevPlugin = os
  .input(z.object({ pluginId: pluginIdSchema }).strict())
  .handler(({ input }) => getPluginManager().reloadDevPlugin(input.pluginId));

export const removeDevPlugin = os
  .input(z.object({ pluginId: pluginIdSchema }).strict())
  .handler(({ input }) => getPluginManager().removeDevPlugin(input.pluginId));
