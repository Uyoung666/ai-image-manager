import { ORPCError, os } from "@orpc/server";
import { z } from "zod";
import { revalidateMainLocalization } from "@/localization/main-runtime";
import {
  getPluginManager,
  PluginManagerError,
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

function rethrowPluginError(error: unknown): never {
  if (error instanceof PluginManagerError) {
    throw new ORPCError("BAD_REQUEST", {
      data: { pluginCode: error.code },
      message: error.message,
    });
  }
  throw error;
}

async function runPluginOperation<T>(
  operation: () => T | PromiseLike<T>
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    rethrowPluginError(error);
  }
}

/**
 * Plugin mutations can remove or replace the currently selected locale
 * provider. Revalidation is deliberately best-effort so a settings/runtime
 * failure never changes the original plugin operation's result or error.
 */
async function runPluginMutation<T>(
  operation: () => T | PromiseLike<T>
): Promise<T> {
  const result = await operation();
  await revalidateMainLocalization().catch(() => undefined);
  return result;
}

export const listPlugins = os.handler(() =>
  runPluginOperation(() => getPluginManager().list())
);

export const installFromDialog = os.handler(() =>
  runPluginOperation(() =>
    runPluginMutation(() => getPluginManager().installFromDialog())
  )
);

export const setPluginEnabled = os
  .input(z.object({ enabled: z.boolean(), pluginId: pluginIdSchema }).strict())
  .handler(({ input }) =>
    runPluginOperation(() =>
      getPluginManager().setEnabled(input.pluginId, input.enabled)
    )
  );

export const setPluginSettings = os
  .input(
    z
      .object({
        pluginId: pluginIdSchema,
        settings: settingsSchema,
      })
      .strict()
  )
  .handler(({ input }) =>
    runPluginOperation(() => {
      const parsed = validatePluginPatch(input);
      return getPluginManager().setSettings(parsed.pluginId, parsed.settings);
    })
  );

export const selectPluginAsset = os
  .input(
    z.object({ pluginId: pluginIdSchema, settingId: settingIdSchema }).strict()
  )
  .handler(({ input }) =>
    runPluginOperation(() => {
      const parsed = validatePluginAssetInput(input);
      return getPluginManager().selectAsset(parsed.pluginId, parsed.settingId);
    })
  );

export const uninstallPlugin = os
  .input(
    z
      .object({ pluginId: pluginIdSchema, removeData: z.boolean().optional() })
      .strict()
  )
  .handler(({ input }) =>
    runPluginOperation(() =>
      runPluginMutation(() =>
        getPluginManager().uninstall(input.pluginId, input.removeData ?? true)
      )
    )
  );

export const inspectFromDialog = os.handler(() =>
  runPluginOperation(() => getPluginManager().inspectFromDialog())
);

export const commitInstall = os
  .input(z.object({ token: tokenSchema }).strict())
  .handler(({ input }) =>
    runPluginOperation(() =>
      runPluginMutation(() => getPluginManager().commitInstall(input.token))
    )
  );

export const discardInspection = os
  .input(z.object({ token: tokenSchema }).strict())
  .handler(({ input }) =>
    runPluginOperation(() => getPluginManager().discardInspection(input.token))
  );

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
    runPluginOperation(() =>
      getPluginManager().reportActivationResult(
        input.pluginId,
        input.version,
        input.success,
        input.errorCode,
        input.errorDetail
      )
    )
  );

export const removePluginAsset = os
  .input(
    z.object({ pluginId: pluginIdSchema, settingId: settingIdSchema }).strict()
  )
  .handler(({ input }) =>
    runPluginOperation(() =>
      getPluginManager().removeAsset(input.pluginId, input.settingId)
    )
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
    runPluginOperation(() =>
      getPluginManager().resetSettings(input.pluginId, input.settingIds)
    )
  );

export const setPluginDeveloperMode = os
  .input(z.object({ enabled: z.boolean() }).strict())
  .handler(({ input }) =>
    runPluginOperation(() =>
      runPluginMutation(() =>
        getPluginManager().setDeveloperMode(input.enabled)
      )
    )
  );

export const loadDevDirectoryFromDialog = os.handler(() =>
  runPluginOperation(() =>
    runPluginMutation(() => getPluginManager().loadDevDirectoryFromDialog())
  )
);

export const reloadDevPlugin = os
  .input(z.object({ pluginId: pluginIdSchema }).strict())
  .handler(({ input }) =>
    runPluginOperation(() =>
      runPluginMutation(() =>
        getPluginManager().reloadDevPlugin(input.pluginId)
      )
    )
  );

export const removeDevPlugin = os
  .input(z.object({ pluginId: pluginIdSchema }).strict())
  .handler(({ input }) =>
    runPluginOperation(() =>
      runPluginMutation(() =>
        getPluginManager().removeDevPlugin(input.pluginId)
      )
    )
  );
