import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import LangToggle from "@/components/lang-toggle";
import type { LocaleOption } from "@/localization/catalog";

const localizationMocks = vi.hoisted(() => ({
  getAvailableLocales: vi.fn(),
  setAppLocale: vi.fn(),
}));

vi.mock("@/actions/localization", () => localizationMocks);

const japanese: LocaleOption = {
  builtIn: false,
  direction: "ltr",
  locale: "ja-JP",
  nativeName: "日本語",
  pluginId: "com.example.japanese",
  version: "1.0.0",
};

describe("LangToggle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localizationMocks.getAvailableLocales.mockResolvedValue([japanese]);
    localizationMocks.setAppLocale.mockResolvedValue(null);
  });

  it("accepts a compact width override for settings layouts", () => {
    render(<LangToggle className="w-[160px]" languages={[]} />);

    expect(
      screen.getByRole("combobox", { name: "settingsLanguage" })
    ).toHaveClass("w-[160px]", "max-w-full");
  });

  it("uses FilterDropdown and loads locale-plugin options asynchronously", async () => {
    render(<LangToggle />);

    const dropdown = await screen.findByRole("combobox", {
      name: "settingsLanguage",
    });
    expect(dropdown).toHaveAttribute("readonly");
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();

    await waitFor(() => expect(dropdown).not.toBeDisabled());
    fireEvent.click(dropdown);
    expect(
      await screen.findByRole("option", { name: "日本語 (ja-JP)" })
    ).toBeInTheDocument();
  });

  it("passes the locale and provider id to the async selection action", async () => {
    render(<LangToggle />);
    const dropdown = await screen.findByRole("combobox", {
      name: "settingsLanguage",
    });
    await waitFor(() => expect(dropdown).not.toBeDisabled());
    fireEvent.click(dropdown);
    fireEvent.click(
      await screen.findByRole("option", { name: "日本語 (ja-JP)" })
    );

    await waitFor(() =>
      expect(localizationMocks.setAppLocale).toHaveBeenCalledWith(
        japanese.locale,
        expect.any(Object),
        japanese.pluginId
      )
    );
  });

  it("keeps a built-in selection when the action applies a local fallback", async () => {
    render(<LangToggle />);
    const dropdown = await screen.findByRole("combobox", {
      name: "settingsLanguage",
    });
    await waitFor(() => expect(dropdown).not.toBeDisabled());
    fireEvent.click(dropdown);
    fireEvent.click(
      await screen.findByRole("option", { name: "English (en)" })
    );

    await waitFor(() => expect(dropdown).toHaveValue("English (en)"));
  });

  it("rolls back the selection only when the action rejects", async () => {
    const error = new Error("locale unavailable");
    const onError = vi.fn();
    localizationMocks.setAppLocale.mockRejectedValueOnce(error);
    render(<LangToggle onError={onError} />);

    const dropdown = await screen.findByRole("combobox", {
      name: "settingsLanguage",
    });
    await waitFor(() => expect(dropdown).not.toBeDisabled());
    fireEvent.click(dropdown);
    fireEvent.click(
      await screen.findByRole("option", { name: "日本語 (ja-JP)" })
    );

    await waitFor(() => expect(dropdown).toHaveValue("中文 (zh)"));
    expect(onError).toHaveBeenCalledWith(error);
  });

  it("supports controlled locale options without the discovery request", async () => {
    const onLanguageChange = vi.fn().mockResolvedValue(undefined);
    render(
      <LangToggle
        languages={[japanese]}
        onLanguageChange={onLanguageChange}
        value={`${japanese.pluginId}:${japanese.locale}`}
      />
    );

    const dropdown = screen.getByRole("combobox", {
      name: "settingsLanguage",
    });
    expect(localizationMocks.getAvailableLocales).not.toHaveBeenCalled();
    fireEvent.click(dropdown);
    fireEvent.click(screen.getByRole("option", { name: "中文 (zh)" }));

    await waitFor(() =>
      expect(onLanguageChange).toHaveBeenCalledWith("zh", null)
    );
  });
});
