import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { Route } from "@/routes/settings";

const state = vi.hoisted(() => ({
  cullSettingsReturn: true,
  navigate: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => options,
  useLocation: () => ({
    pathname: "/settings/cull-archive",
    state: { cullSettingsReturn: state.cullSettingsReturn },
  }),
  useNavigate: () => state.navigate,
  Outlet: () => <div />,
}));
vi.mock("@/components/settings/SettingsSidebar", () => ({
  SettingsSidebar: () => <nav />,
}));

it.each([
  true,
  false,
])("returns settings to its entry point (from culling: %s)", (fromCull) => {
  state.cullSettingsReturn = fromCull;
  state.navigate.mockClear();
  const Layout = (Route as unknown as { component: () => React.ReactNode })
    .component;
  render(<Layout />);
  fireEvent.click(
    screen.getByRole("button", {
      name: fromCull ? "cullProject.back" : "settingsBackHome",
    })
  );
  expect(state.navigate).toHaveBeenCalledWith({
    to: fromCull ? "/cull" : "/",
    state: { cullSettingsReturn: false },
  });
});
