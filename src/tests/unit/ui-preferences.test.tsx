import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cacheReduceMotion,
  getReduceMotionPreference,
  readCachedReduceMotion,
  setReduceMotionPreference,
  UI_REDUCE_MOTION_KEY,
} from "@/actions/ui-preferences";
import { UiPreferencesProvider } from "@/contexts/ui-preferences-context";
import { useUiPreferences } from "@/hooks/use-reduced-motion";

const settingsMocks = vi.hoisted(() => ({
  getAppSetting: vi.fn(),
  setAppPreference: vi.fn(),
}));

vi.mock("@/ipc/manager", () => ({
  ipc: {
    client: {
      settings: settingsMocks,
    },
  },
}));

function PreferenceProbe() {
  const { reduceMotion, setReduceMotion } = useUiPreferences();
  return (
    <button onClick={() => setReduceMotion(!reduceMotion)} type="button">
      {String(reduceMotion)}
    </button>
  );
}

describe("UI reduced-motion preference", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.dataset.reducedMotion = "false";
    settingsMocks.getAppSetting.mockReset();
    settingsMocks.setAppPreference.mockReset();
    settingsMocks.getAppSetting.mockResolvedValue({
      key: UI_REDUCE_MOTION_KEY,
      value: "false",
    });
    settingsMocks.setAppPreference.mockResolvedValue({ ok: true });
  });

  it("defaults to disabled and caches the boolean value", () => {
    expect(readCachedReduceMotion()).toBe(false);
    cacheReduceMotion(true);
    expect(readCachedReduceMotion()).toBe(true);
  });

  it("reads and writes ui.reduceMotion through the existing settings IPC", async () => {
    settingsMocks.getAppSetting.mockResolvedValueOnce({
      key: UI_REDUCE_MOTION_KEY,
      value: "true",
    });

    await expect(getReduceMotionPreference()).resolves.toBe(true);
    expect(settingsMocks.getAppSetting).toHaveBeenCalledWith({
      key: UI_REDUCE_MOTION_KEY,
    });

    await setReduceMotionPreference(false);
    expect(settingsMocks.setAppPreference).toHaveBeenCalledWith({
      key: UI_REDUCE_MOTION_KEY,
      value: "false",
    });
    expect(readCachedReduceMotion()).toBe(false);
  });

  it("uses the cache for the first render and syncs the root attribute", () => {
    cacheReduceMotion(true);
    settingsMocks.getAppSetting.mockReturnValue(new Promise(() => undefined));

    render(
      <UiPreferencesProvider>
        <PreferenceProbe />
      </UiPreferencesProvider>
    );

    expect(screen.getByRole("button")).toHaveTextContent("true");
    expect(document.documentElement).toHaveAttribute(
      "data-reduced-motion",
      "true"
    );
  });

  it("updates the root attribute immediately when the preference is toggled", async () => {
    settingsMocks.getAppSetting.mockReturnValue(new Promise(() => undefined));
    render(
      <UiPreferencesProvider>
        <PreferenceProbe />
      </UiPreferencesProvider>
    );

    act(() => {
      screen.getByRole("button").click();
    });

    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute(
        "data-reduced-motion",
        "true"
      );
      expect(settingsMocks.setAppPreference).toHaveBeenCalledWith({
        key: UI_REDUCE_MOTION_KEY,
        value: "true",
      });
    });
  });
});
