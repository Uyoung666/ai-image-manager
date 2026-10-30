import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SettingsSidebar } from "@/components/settings/SettingsSidebar";

const navigate = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-router", () => ({
  useLocation: () => ({
    pathname: "/settings/appearance",
    state: { cullSettingsReturn: true },
  }),
  useNavigate: () => navigate,
}));

describe("SettingsSidebar", () => {
  it("renders the seven settings categories and their navigation", () => {
    render(<SettingsSidebar />);

    for (const group of [
      "settingsGroupAppearance",
      "settingsGroupBehavior",
      "settingsGroupPhotos",
      "settingsGroupData",
      "settingsGroupOutput",
      "settingsGroupUpdates",
      "settingsGroupHelp",
    ]) {
      expect(screen.getByText(group)).toBeInTheDocument();
    }

    expect(screen.getByText("settingsAppearance")).toBeInTheDocument();
    expect(screen.getByText("settingsBehavior")).toBeInTheDocument();
    expect(screen.getByText("settingsDiagnostics")).toBeInTheDocument();
    expect(
      screen.queryByPlaceholderText("settingsSearchPlaceholder")
    ).not.toBeInTheDocument();
  });

  it("opens AI index settings from an accessible sidebar control", () => {
    render(<SettingsSidebar />);
    fireEvent.click(screen.getByRole("button", { name: "settingsAiIndex" }));
    expect(navigate).toHaveBeenCalledWith({
      to: "/settings/ai-index",
      state: { cullSettingsReturn: true },
    });
  });
});
