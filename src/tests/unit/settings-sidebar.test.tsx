import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SettingsSidebar } from "@/components/settings/SettingsSidebar";

vi.mock("@tanstack/react-router", () => ({
  useLocation: () => ({ pathname: "/settings/appearance" }),
  useNavigate: () => vi.fn(),
}));

describe("SettingsSidebar", () => {
  it("renders the six settings categories and their navigation", () => {
    render(<SettingsSidebar />);

    for (const group of [
      "settingsGroupAppearance",
      "settingsGroupBehavior",
      "settingsGroupPhotos",
      "settingsGroupData",
      "settingsGroupOutput",
      "settingsGroupUpdates",
    ]) {
      expect(screen.getByText(group)).toBeInTheDocument();
    }

    expect(screen.getByText("settingsAppearance")).toBeInTheDocument();
    expect(screen.getByText("settingsBehavior")).toBeInTheDocument();
    expect(
      screen.queryByPlaceholderText("settingsSearchPlaceholder")
    ).not.toBeInTheDocument();
  });
});
