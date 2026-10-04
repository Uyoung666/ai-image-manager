import {
  createPluginTrustedKeyring,
  type PluginTrustedKeyring,
} from "@/services/plugin-manager";
import officialLocalePublicKeys from "./official-locale-public-keys.json";

/** Public release keys shipped with the application; private keys stay off-repo. */
export const OFFICIAL_LOCALE_TRUSTED_KEYS: PluginTrustedKeyring =
  createPluginTrustedKeyring(officialLocalePublicKeys);
