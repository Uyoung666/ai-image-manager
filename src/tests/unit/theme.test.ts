import { waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  enterTemporaryDarkTheme,
  listenSystemThemeChanges,
  setTheme,
} from "@/actions/theme";
import { LOCAL_STORAGE_KEYS } from "@/constants";

const mocks = vi.hoisted(() => ({
  getCurrentThemeMode: vi.fn(),
  setThemeMode: vi.fn(),
}));

vi.mock("@/ipc/manager", () => ({
  ipc: {
    client: {
      theme: mocks,
    },
  },
}));

describe("temporary theme override", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    document.documentElement.classList.remove("dark", "light");
    mocks.getCurrentThemeMode.mockResolvedValue("light");
    mocks.setThemeMode.mockResolvedValue("light");
  });

  it("forces dark mode without changing a light preference and restores it", async () => {
    localStorage.setItem(LOCAL_STORAGE_KEYS.THEME, "light");
    document.documentElement.classList.add("light");

    const restore = enterTemporaryDarkTheme();

    expect(document.documentElement).toHaveClass("dark");
    expect(document.documentElement).not.toHaveClass("light");
    expect(localStorage.getItem(LOCAL_STORAGE_KEYS.THEME)).toBe("light");
    expect(mocks.setThemeMode).not.toHaveBeenCalled();

    restore();
    await waitFor(() => {
      expect(document.documentElement).toHaveClass("light");
    });
  });

  it("keeps system theme changes suppressed until the override is released", async () => {
    localStorage.setItem(LOCAL_STORAGE_KEYS.THEME, "system");
    const removeSystemListener = listenSystemThemeChanges();
    const restore = enterTemporaryDarkTheme();

    window.dispatchEvent(
      new MessageEvent("message", {
        data: { channel: "theme:system-changed", resolved: "light" },
      })
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(document.documentElement).toHaveClass("dark");

    restore();
    await waitFor(() => {
      expect(document.documentElement).toHaveClass("light");
    });

    removeSystemListener();
  });

  it("retains a theme preference changed during PK and applies it after exit", async () => {
    localStorage.setItem(LOCAL_STORAGE_KEYS.THEME, "light");
    const restore = enterTemporaryDarkTheme();

    mocks.setThemeMode.mockResolvedValue("dark");
    await setTheme("dark");

    expect(document.documentElement).toHaveClass("dark");
    expect(localStorage.getItem(LOCAL_STORAGE_KEYS.THEME)).toBe("dark");
    expect(mocks.setThemeMode).toHaveBeenCalledTimes(1);

    restore();
    await waitFor(() => {
      expect(document.documentElement).toHaveClass("dark");
    });
  });
});
