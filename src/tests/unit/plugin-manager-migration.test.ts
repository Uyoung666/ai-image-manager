import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  NEBULA_GLASS_MANIFEST,
  NEBULA_GLASS_PLUGIN_ID,
} from "@/plugins/builtins/nebula-glass-manifest";

const settingsState = vi.hoisted(() => ({
  values: new Map<string, string>(),
  writes: [] as [string, string][],
}));

vi.mock("@/services/settings-manager", () => ({
  getSetting: (key: string) => settingsState.values.get(key) ?? null,
  setSetting: (key: string, value: string) => {
    settingsState.values.set(key, value);
    settingsState.writes.push([key, value]);
  },
}));

import { PluginManager } from "@/services/plugin-manager";

const settingsKey = `plugins.${NEBULA_GLASS_PLUGIN_ID}.settings`;
const recipeVersionKey = `plugins.${NEBULA_GLASS_PLUGIN_ID}.recipeVersion`;

describe("PluginManager Nebula Glass recipe migration", () => {
  beforeEach(() => {
    settingsState.values.clear();
    settingsState.writes.length = 0;
  });

  it("migrates and persists the built-in recipe once while listing plugins", async () => {
    settingsState.values.set(
      settingsKey,
      JSON.stringify({
        backdropBlur: 18,
        blur: 18,
        fluidDepth: 62,
        fluidHue: 210,
        frost: 48,
        edgeFade: true,
        mesh: true,
        particles: true,
      })
    );
    const manager = new PluginManager([NEBULA_GLASS_MANIFEST]);

    const first = await manager.list();
    const nebula = first.plugins.find(
      (plugin) => plugin.manifest.id === NEBULA_GLASS_PLUGIN_ID
    );

    expect(nebula?.settings).toMatchObject({
      backdropBlur: 0,
      blur: 20,
      fluidDepth: 25,
      fluidHue: 320,
      frost: 7,
    });
    expect(nebula?.settings).not.toHaveProperty("edgeFade");
    expect(nebula?.settings).not.toHaveProperty("mesh");
    expect(nebula?.settings).not.toHaveProperty("particles");
    expect(settingsState.values.get(recipeVersionKey)).toBe("3");

    const writesAfterMigration = settingsState.writes.length;
    settingsState.values.set(
      settingsKey,
      JSON.stringify({ ...nebula?.settings, blur: 18 })
    );
    const second = await manager.list();
    const secondNebula = second.plugins.find(
      (plugin) => plugin.manifest.id === NEBULA_GLASS_PLUGIN_ID
    );

    expect(secondNebula?.settings.blur).toBe(18);
    expect(settingsState.writes).toHaveLength(writesAfterMigration);
  });
});
