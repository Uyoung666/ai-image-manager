import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Route as AppearanceRoute } from "@/routes/settings.appearance";
import { Route as BehaviorRoute } from "@/routes/settings.behavior";
import { Route as SequenceRoute } from "@/routes/settings.sequences";

const mocks = vi.hoisted(() => ({
  accent: {
    applyAccentColor: vi.fn(),
    cacheAccentColor: vi.fn(),
    getAccentColorPreference: vi.fn(),
    getCurrentAccentTheme: vi.fn(),
    getAccentColorOptions: vi.fn(),
    parseAccentColor: vi.fn(),
    readCachedAccentColor: vi.fn(),
    setAccentColorPreference: vi.fn(),
  },
  settings: {
    getAppPreferences: vi.fn(),
    getAppSetting: vi.fn(),
    getOpenAtLogin: vi.fn(),
    setAppPreference: vi.fn(),
    setAppSetting: vi.fn(),
    setOpenAtLogin: vi.fn(),
  },
  setReduceMotion: vi.fn(),
  setZoomFactor: vi.fn(),
  theme: {
    getCurrentTheme: vi.fn(),
  },
  toast: {
    error: vi.fn(),
  },
}));

vi.mock("@/actions/accent-color", () => mocks.accent);

vi.mock("@/actions/theme", () => mocks.theme);

vi.mock("@/actions/window", () => ({
  setZoomFactor: mocks.setZoomFactor,
}));

vi.mock("@/components/filter-dropdown", () => ({
  FilterDropdown: ({
    ariaLabel,
    onChange,
    options,
    value,
  }: {
    ariaLabel?: string;
    onChange: (value: string) => void;
    options: readonly { label: string; value: string }[];
    value: string;
  }) => (
    <select
      aria-label={ariaLabel}
      onChange={(event) => onChange(event.target.value)}
      value={value}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));

vi.mock("@/components/lang-toggle", () => ({
  default: () => null,
}));

vi.mock("@/components/toggle-theme", () => ({
  default: () => null,
}));

vi.mock("@/components/ui/switch", () => ({
  Switch: ({
    ariaLabel,
    checked,
    onCheckedChange,
  }: {
    ariaLabel?: string;
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
  }) => (
    <input
      aria-label={ariaLabel}
      checked={checked}
      onChange={(event) => onCheckedChange(event.target.checked)}
      type="checkbox"
    />
  ),
}));

vi.mock("@/hooks/use-reduced-motion", () => ({
  useUiPreferences: () => ({
    reduceMotion: false,
    setReduceMotion: mocks.setReduceMotion,
  }),
}));

vi.mock("@/hooks/useRouteScrollRestoration", () => ({
  useRouteScrollRestoration: () => undefined,
}));

vi.mock("@/ipc/manager", () => ({
  ipc: {
    client: {
      settings: mocks.settings,
    },
  },
}));

vi.mock("sonner", () => ({
  toast: mocks.toast,
}));

function renderRoute(route: {
  options: {
    component?: React.ComponentType;
  };
}) {
  const Page = route.options.component;
  if (!Page) {
    throw new Error("Expected settings route component");
  }
  return render(<Page />);
}

function deferred<T>() {
  let reject!: (reason?: unknown) => void;
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

describe("settings save failures", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mocks.accent.applyAccentColor.mockImplementation((value: string) => value);
    mocks.accent.cacheAccentColor.mockImplementation(() => undefined);
    mocks.accent.getAccentColorPreference.mockResolvedValue("default");
    mocks.accent.getCurrentAccentTheme.mockReturnValue("dark");
    mocks.accent.getAccentColorOptions.mockReturnValue([
      { color: "#777", labelKey: "accentDefault", value: "default" },
      { color: "#e85d8c", labelKey: "accentPink", value: "pink" },
    ]);
    mocks.accent.parseAccentColor.mockImplementation((value: string) =>
      value === "pink" ? "pink" : "default"
    );
    mocks.accent.readCachedAccentColor.mockReturnValue("default");
    mocks.accent.setAccentColorPreference.mockResolvedValue("default");
    mocks.settings.getAppPreferences.mockResolvedValue({
      accentColor: "default",
      closeBehavior: "tray",
      rememberBounds: false,
    });
    mocks.settings.getAppSetting.mockImplementation(
      ({ key }: { key: string }) => {
        if (key === "sequence.detection.settings") {
          return Promise.resolve({
            value: JSON.stringify({
              preset: "balanced",
            }),
          });
        }
        if (key === "ui.zoomScale") {
          return Promise.resolve({ value: "1" });
        }
        return Promise.resolve({ value: "standard" });
      }
    );
    mocks.settings.getOpenAtLogin.mockResolvedValue({ openAtLogin: false });
    mocks.settings.setAppPreference.mockResolvedValue({ ok: true });
    mocks.settings.setAppSetting.mockResolvedValue({ ok: true });
    mocks.settings.setOpenAtLogin.mockResolvedValue({ ok: true });
    mocks.setReduceMotion.mockResolvedValue(undefined);
    mocks.setZoomFactor.mockResolvedValue(undefined);
    mocks.theme.getCurrentTheme.mockResolvedValue("dark");
  });

  it("shows an error and rolls back a failed behavior save", async () => {
    mocks.settings.setAppPreference.mockRejectedValueOnce(
      new Error("settings unavailable")
    );
    renderRoute(BehaviorRoute);

    await waitFor(() =>
      expect(mocks.settings.getAppPreferences).toHaveBeenCalled()
    );
    const rememberBounds = screen.getByRole("checkbox", {
      name: "settingsRememberWindowBounds",
    });
    fireEvent.click(rememberBounds);

    await waitFor(() => expect(rememberBounds).not.toBeChecked());
    expect(mocks.toast.error).toHaveBeenCalledWith("saveFailed");
  });

  it("rolls back to the committed sequence value after consecutive failures", async () => {
    const firstSave = deferred<void>();
    const secondSave = deferred<void>();
    let saveCount = 0;
    mocks.settings.setAppSetting.mockImplementation(({ key }) => {
      if (key !== "sequence.detection.settings") {
        return Promise.resolve({ ok: true });
      }
      saveCount += 1;
      return saveCount === 1 ? firstSave.promise : secondSave.promise;
    });
    renderRoute(SequenceRoute);

    await waitFor(() =>
      expect(mocks.settings.getAppSetting).toHaveBeenCalledWith({
        key: "sequence.detection.settings",
      })
    );
    const [strictPreset, balancedPreset] = screen.getAllByRole("radio");
    fireEvent.click(strictPreset);
    fireEvent.click(balancedPreset);
    firstSave.reject(new Error("first save failed"));

    await waitFor(() => expect(balancedPreset).toBeChecked());
    expect(mocks.toast.error).not.toHaveBeenCalled();

    secondSave.reject(new Error("second save failed"));
    await waitFor(() => expect(balancedPreset).toBeChecked());
    expect(mocks.toast.error).toHaveBeenCalledTimes(1);
    expect(mocks.toast.error).toHaveBeenCalledWith("saveFailed");
  });

  it("keeps the newest sequence value when an older save fails", async () => {
    const firstSave = deferred<void>();
    const secondSave = deferred<void>();
    let saveCount = 0;
    mocks.settings.setAppSetting.mockImplementation(({ key }) => {
      if (key !== "sequence.detection.settings") {
        return Promise.resolve({ ok: true });
      }
      saveCount += 1;
      return saveCount === 1 ? firstSave.promise : secondSave.promise;
    });
    renderRoute(SequenceRoute);

    await waitFor(() =>
      expect(mocks.settings.getAppSetting).toHaveBeenCalledWith({
        key: "sequence.detection.settings",
      })
    );
    const [strictPreset, , relaxedPreset] = screen.getAllByRole("radio");
    fireEvent.click(strictPreset);
    fireEvent.click(relaxedPreset);
    firstSave.reject(new Error("first save failed"));
    secondSave.resolve();

    await waitFor(() => expect(relaxedPreset).toBeChecked());
    expect(mocks.toast.error).not.toHaveBeenCalled();
  });

  it("does not let a late sequence load replace a queued change", async () => {
    const loadedSettings = deferred<{ value: string }>();
    const savedSettings = deferred<{ ok: true }>();
    mocks.settings.getAppSetting.mockImplementation(({ key }) => {
      if (key === "sequence.detection.settings") {
        return loadedSettings.promise;
      }
      return Promise.resolve({ value: "standard" });
    });
    mocks.settings.setAppSetting.mockImplementation(({ key }) => {
      if (key === "sequence.detection.settings") {
        return savedSettings.promise;
      }
      return Promise.resolve({ ok: true });
    });
    renderRoute(SequenceRoute);

    await waitFor(() =>
      expect(mocks.settings.getAppSetting).toHaveBeenCalledWith({
        key: "sequence.detection.settings",
      })
    );
    const [strictPreset, balancedPreset] = screen.getAllByRole("radio");
    fireEvent.click(strictPreset);
    expect(strictPreset).toBeChecked();

    loadedSettings.resolve({
      value: JSON.stringify({ preset: "balanced" }),
    });
    await waitFor(() =>
      expect(mocks.settings.setAppSetting).toHaveBeenCalledWith({
        key: "sequence.detection.settings",
        value: expect.stringContaining('"preset":"strict"'),
      })
    );
    expect(strictPreset).toBeChecked();
    expect(balancedPreset).not.toBeChecked();
    savedSettings.resolve({ ok: true });
  });

  it("does not let a late behavior load replace a queued change", async () => {
    const loadedPreferences = deferred<{
      closeBehavior: "tray";
      rememberBounds: boolean;
    }>();
    const savedPreference = deferred<{ ok: true }>();
    mocks.settings.getAppPreferences.mockReturnValue(loadedPreferences.promise);
    mocks.settings.setAppPreference.mockImplementation(({ key }) => {
      if (key === "window.rememberBounds") {
        return savedPreference.promise;
      }
      return Promise.resolve({ ok: true });
    });
    renderRoute(BehaviorRoute);

    await waitFor(() =>
      expect(mocks.settings.getAppPreferences).toHaveBeenCalled()
    );
    const rememberBounds = screen.getByRole("checkbox", {
      name: "settingsRememberWindowBounds",
    });
    fireEvent.click(rememberBounds);
    expect(rememberBounds).toBeChecked();

    loadedPreferences.resolve({ closeBehavior: "tray", rememberBounds: false });
    await waitFor(() =>
      expect(mocks.settings.setAppPreference).toHaveBeenCalledWith({
        key: "window.rememberBounds",
        value: "true",
      })
    );
    expect(rememberBounds).toBeChecked();
    savedPreference.resolve({ ok: true });
  });

  it("hydrates appearance zoom before applying a queued change", async () => {
    const loadedZoom = deferred<{ value: string }>();
    const savedZoom = deferred<{ ok: true }>();
    mocks.settings.getAppSetting.mockImplementation(({ key }) => {
      if (key === "ui.zoomScale") {
        return loadedZoom.promise;
      }
      return Promise.resolve({ value: "standard" });
    });
    mocks.settings.setAppSetting.mockImplementation(({ key }) => {
      if (key === "ui.zoomScale") {
        return savedZoom.promise;
      }
      return Promise.resolve({ ok: true });
    });
    renderRoute(AppearanceRoute);

    await waitFor(() =>
      expect(mocks.settings.getAppSetting).toHaveBeenCalledWith({
        key: "ui.zoomScale",
      })
    );
    const scale110 = screen.getByRole("button", { name: "110%" });
    const scale100 = screen.getByRole("button", { name: "100%" });
    fireEvent.click(scale110);
    expect(scale110).toHaveAttribute("aria-pressed", "true");
    expect(mocks.setZoomFactor).not.toHaveBeenCalled();

    loadedZoom.resolve({ value: "1" });
    await waitFor(() =>
      expect(mocks.settings.setAppSetting).toHaveBeenCalledWith({
        key: "ui.zoomScale",
        value: "1.1",
      })
    );
    expect(scale110).toHaveAttribute("aria-pressed", "true");
    expect(scale100).toHaveAttribute("aria-pressed", "false");
    expect(mocks.setZoomFactor).toHaveBeenCalledWith(1.1);
    savedZoom.resolve({ ok: true });
  });

  it("restores the optimistic accent after a late getter applies its value", async () => {
    const loadedAccent = deferred<"default" | "pink">();
    mocks.accent.getAccentColorPreference.mockImplementation(() =>
      loadedAccent.promise.then((value) => {
        mocks.accent.applyAccentColor(value);
        mocks.accent.cacheAccentColor(value);
        return value;
      })
    );
    renderRoute(AppearanceRoute);

    await waitFor(() =>
      expect(mocks.accent.getAccentColorPreference).toHaveBeenCalled()
    );
    const accentColor = screen.getByRole("combobox", {
      name: "settingsAccentColor",
    });
    fireEvent.change(accentColor, { target: { value: "pink" } });
    loadedAccent.resolve("default");

    await waitFor(() =>
      expect(mocks.accent.setAccentColorPreference).toHaveBeenCalledWith("pink")
    );
    expect(mocks.accent.applyAccentColor).toHaveBeenLastCalledWith("pink");
    expect(mocks.accent.cacheAccentColor).toHaveBeenLastCalledWith("pink");
  });

  it("continues a queued sequence save when the initial load fails", async () => {
    const loadedSettings = deferred<{ value: string }>();
    const savedSettings = deferred<{ ok: true }>();
    mocks.settings.getAppSetting.mockImplementation(({ key }) => {
      if (key === "sequence.detection.settings") {
        return loadedSettings.promise;
      }
      return Promise.resolve({ value: "standard" });
    });
    mocks.settings.setAppSetting.mockImplementation(({ key }) => {
      if (key === "sequence.detection.settings") {
        return savedSettings.promise;
      }
      return Promise.resolve({ ok: true });
    });
    renderRoute(SequenceRoute);

    await waitFor(() =>
      expect(mocks.settings.getAppSetting).toHaveBeenCalledWith({
        key: "sequence.detection.settings",
      })
    );
    const [strictPreset] = screen.getAllByRole("radio");
    fireEvent.click(strictPreset);
    loadedSettings.reject(new Error("settings unavailable"));

    await waitFor(() =>
      expect(mocks.settings.setAppSetting).toHaveBeenCalledWith({
        key: "sequence.detection.settings",
        value: expect.stringContaining('"preset":"strict"'),
      })
    );
    expect(strictPreset).toBeChecked();
    savedSettings.resolve({ ok: true });
  });

  it("shows an error and rolls back a failed appearance save", async () => {
    mocks.settings.setAppSetting.mockRejectedValueOnce(
      new Error("settings unavailable")
    );
    renderRoute(AppearanceRoute);

    const scale110 = screen.getByRole("button", { name: "110%" });
    fireEvent.click(scale110);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "100%" })).toHaveAttribute(
        "aria-pressed",
        "true"
      );
    });
    expect(mocks.toast.error).toHaveBeenCalledWith("saveFailed");
  });

  it("handles a failed zoom apply without an unhandled rejection", async () => {
    mocks.setZoomFactor.mockRejectedValueOnce(new Error("window unavailable"));
    renderRoute(AppearanceRoute);

    fireEvent.click(screen.getByRole("button", { name: "110%" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "100%" })).toHaveAttribute(
        "aria-pressed",
        "true"
      );
    });
    expect(mocks.settings.setAppSetting).not.toHaveBeenCalled();
    expect(mocks.setZoomFactor).toHaveBeenNthCalledWith(1, 1.1);
    expect(mocks.setZoomFactor).toHaveBeenNthCalledWith(2, 1);
    expect(mocks.toast.error).toHaveBeenCalledWith("saveFailed");
  });

  it("restores the actual zoom when appearance persistence fails", async () => {
    mocks.settings.setAppSetting.mockRejectedValueOnce(
      new Error("settings unavailable")
    );
    renderRoute(AppearanceRoute);

    fireEvent.click(screen.getByRole("button", { name: "110%" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "100%" })).toHaveAttribute(
        "aria-pressed",
        "true"
      );
    });
    expect(mocks.setZoomFactor).toHaveBeenNthCalledWith(1, 1.1);
    expect(mocks.setZoomFactor).toHaveBeenNthCalledWith(2, 1);
    expect(mocks.toast.error).toHaveBeenCalledWith("saveFailed");
  });

  it("restores the committed zoom after consecutive saves fail", async () => {
    const firstSave = deferred<void>();
    const secondSave = deferred<void>();
    let saveCount = 0;
    mocks.settings.setAppSetting.mockImplementation(({ key }) => {
      if (key !== "ui.zoomScale") {
        return Promise.resolve({ ok: true });
      }
      saveCount += 1;
      return saveCount === 1 ? firstSave.promise : secondSave.promise;
    });
    renderRoute(AppearanceRoute);

    await waitFor(() =>
      expect(mocks.settings.getAppSetting).toHaveBeenCalledWith({
        key: "ui.zoomScale",
      })
    );
    await Promise.resolve();

    const scale110 = screen.getByRole("button", { name: "110%" });
    const scale120 = screen.getByRole("button", { name: "120%" });
    fireEvent.click(scale110);
    fireEvent.click(scale120);
    expect(scale120).toHaveAttribute("aria-pressed", "true");

    firstSave.reject(new Error("first save failed"));
    await waitFor(() =>
      expect(mocks.settings.setAppSetting).toHaveBeenCalledWith({
        key: "ui.zoomScale",
        value: "1.2",
      })
    );
    secondSave.reject(new Error("second save failed"));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "100%" })).toHaveAttribute(
        "aria-pressed",
        "true"
      )
    );
    expect(mocks.setZoomFactor).toHaveBeenNthCalledWith(1, 1.1);
    expect(mocks.setZoomFactor).toHaveBeenNthCalledWith(2, 1.2);
    expect(mocks.setZoomFactor).toHaveBeenNthCalledWith(3, 1);
    expect(mocks.toast.error).toHaveBeenCalledWith("saveFailed");
  });
});
