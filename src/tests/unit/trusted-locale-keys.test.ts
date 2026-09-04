/** @vitest-environment node */
import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";

const electronState = vi.hoisted(() => ({ userData: "" }));

vi.mock("electron", () => ({
  app: {
    getLocale: () => "en-US",
    getPath: () => electronState.userData,
    getVersion: () => "2.0.0",
  },
  dialog: { showOpenDialog: vi.fn() },
  protocol: { handle: vi.fn() },
}));

import { OFFICIAL_LOCALE_TRUSTED_KEYS } from "@/plugins/trusted-locale-keys";
import {
  createPluginTrustedKeyring,
  PLUGIN_TRUSTED_KEYS,
} from "@/services/plugin-manager";

const RELEASE_KEY_ID = "uyoung-locale-release-1";

describe("official locale trusted keyring", () => {
  it("ships one frozen Ed25519 public key under the release key ID", () => {
    expect(Object.keys(OFFICIAL_LOCALE_TRUSTED_KEYS)).toEqual([RELEASE_KEY_ID]);
    expect(Object.isFrozen(OFFICIAL_LOCALE_TRUSTED_KEYS)).toBe(true);
    expect(Object.getPrototypeOf(OFFICIAL_LOCALE_TRUSTED_KEYS)).toBeNull();

    const key = OFFICIAL_LOCALE_TRUSTED_KEYS[RELEASE_KEY_ID];
    expect(key).toBeDefined();
    expect(key).toMatchObject({
      asymmetricKeyType: "ed25519",
      type: "public",
    });
  });

  it("keeps the source default keyring empty while accepting the official keyring", () => {
    expect(PLUGIN_TRUSTED_KEYS).toEqual({});
    expect(() =>
      createPluginTrustedKeyring(OFFICIAL_LOCALE_TRUSTED_KEYS)
    ).not.toThrow();
  });

  it("injects the official keyring at the main-process entry point", () => {
    const mainSource = fs.readFileSync(
      new URL("../../main.ts", import.meta.url),
      "utf8"
    );
    expect(mainSource).toContain(
      'import { OFFICIAL_LOCALE_TRUSTED_KEYS } from "./plugins/trusted-locale-keys";'
    );
    expect(mainSource).toContain(
      "configurePluginManager([NEBULA_GLASS_MANIFEST], OFFICIAL_LOCALE_TRUSTED_KEYS);"
    );
  });
});
