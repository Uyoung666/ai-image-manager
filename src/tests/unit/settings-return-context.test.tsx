import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { Route } from "@/routes/settings";

const state = vi.hoisted(() => ({
  cullSettingsReturn: true,
  navigate: vi.fn(),
  go: vi.fn(),
  libraryReturnIndex: undefined as number | undefined,
  index: 4,
}));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => options,
  useLocation: () => ({
    pathname: "/settings/cull-archive",
    state: {
      cullSettingsReturn: state.cullSettingsReturn,
      libraryReturnIndex: state.libraryReturnIndex,
      __TSR_index: state.index,
    },
  }),
  useNavigate: () => state.navigate,
  useRouter: () => ({ history: { go: state.go, canGoBack: () => true } }),
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

it("returns to the original browsing entry after multiple settings navigations", () => {
  state.libraryReturnIndex = 1;
  state.index = 5;
  state.go.mockClear();
  const Layout = (Route as unknown as { component: () => React.ReactNode })
    .component;
  render(<Layout />);
  fireEvent.click(screen.getByTestId("settings-back"));
  expect(state.go).toHaveBeenCalledWith(-4);
  state.libraryReturnIndex = undefined;
});
