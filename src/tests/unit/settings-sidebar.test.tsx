import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SettingsSidebar } from "@/components/settings/SettingsSidebar";

vi.mock("@tanstack/react-router", () => ({
  useLocation: () => ({ pathname: "/settings/appearance" }),
  useNavigate: () => vi.fn(),
}));

describe("SettingsSidebar", () => {
  it("keeps navigation without a dedicated settings search input", () => {
    render(<SettingsSidebar />);

    expect(
      screen.queryByPlaceholderText("settingsSearchPlaceholder")
    ).not.toBeInTheDocument();
    expect(screen.getByText("settingsAppearance")).toBeInTheDocument();
  });
});
