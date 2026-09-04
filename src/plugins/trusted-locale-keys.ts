import {
  createPluginTrustedKeyring,
  type PluginTrustedKeyring,
} from "@/services/plugin-manager";

const OFFICIAL_LOCALE_PUBLIC_KEYS = {
  "uyoung-locale-release-1": `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAkivHIyKvasePl1SYDqtDCrXqoPgGLhDfQuV+6DAzGkw=
-----END PUBLIC KEY-----`,
} as const;

/** Public release keys shipped with the application; private keys stay off-repo. */
export const OFFICIAL_LOCALE_TRUSTED_KEYS: PluginTrustedKeyring =
  createPluginTrustedKeyring(OFFICIAL_LOCALE_PUBLIC_KEYS);
