import { getPluginManager } from "@/services/plugin-manager";
import {
  type LocaleBundle,
  type LocaleProviderSummary,
  validateLocaleBundle,
  validateLocaleProviderSummary,
} from "./catalog";

/**
 * The plugin manager owns package extraction, signature verification and
 * containment checks. The localization runtime only calls its explicit,
 * validated locale capability API and never inspects plugin directories.
 */
function managerOrNull() {
  try {
    return getPluginManager();
  } catch {
    // Unit tests and early startup can observe the bridge before the manager
    // is configured.  Built-in languages remain available in that case.
    return null;
  }
}

export async function listVerifiedLocaleProviders(): Promise<
  LocaleProviderSummary[]
> {
  const manager = managerOrNull();
  if (!manager) {
    return [];
  }
  try {
    const result = await manager.listLocaleProviders();
    return result
      .map((item) =>
        validateLocaleProviderSummary({
          direction: "ltr",
          locale: item.tag,
          nativeName: item.nativeName,
          pluginId: item.pluginId,
          ...(item.version ? { version: item.version } : {}),
        })
      )
      .filter((item): item is LocaleProviderSummary => item !== null);
  } catch {
    return [];
  }
}

export async function loadVerifiedLocaleProvider(
  pluginId: string,
  expectedLocale?: string,
  version?: string
): Promise<LocaleBundle | null> {
  const manager = managerOrNull();
  if (!manager) {
    return null;
  }
  try {
    const result = await manager.loadLocaleProvider(pluginId, version);
    return validateLocaleBundle(
      {
        direction: "ltr",
        locale: result.tag,
        main: result.main,
        nativeName: result.nativeName,
        providerPluginId: result.pluginId,
        renderer: result.renderer,
        ...(result.version ? { version: result.version } : {}),
      },
      {
        locale: expectedLocale,
        pluginId,
      }
    );
  } catch {
    return null;
  }
}
