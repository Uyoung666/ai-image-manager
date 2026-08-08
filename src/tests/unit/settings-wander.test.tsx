import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Route } from "@/routes/settings.wander";
import { DEFAULT_WANDER_SETTINGS, type WanderSettings } from "@/types/wander";

const { wanderState } = vi.hoisted(() => ({
  wanderState: {
    active: false,
    loading: false,
    preferences: null as unknown as WanderSettings,
    start: vi.fn(),
    updatePreference: vi.fn(),
  },
}));

vi.mock("@/providers/WanderProvider", () => ({
  useWander: () => wanderState,
}));

vi.mock("@/hooks/useRouteScrollRestoration", () => ({
  useRouteScrollRestoration: () => undefined,
}));

vi.mock("@/components/ui/switch", () => ({
  Switch: (props: {
    checked?: boolean;
    disabled?: boolean;
    onCheckedChange?: (checked: boolean) => void;
  }) => (
    <button
      aria-checked={props.checked}
      data-checked={props.checked}
      disabled={props.disabled}
      onClick={() => props.onCheckedChange?.(!props.checked)}
      role="switch"
      type="button"
    />
  ),
}));

function renderPage() {
  const Page = Route.options.component;
  return render(<Page />);
}

function modeSwitch(titleKey: string): HTMLElement {
  const title = screen.getByText(titleKey);
  const row = title.parentElement?.parentElement as HTMLElement;
  return within(row).getByRole("switch");
}

describe("settings.wander", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wanderState.active = false;
    wanderState.loading = false;
    wanderState.updatePreference.mockResolvedValue(undefined);
    wanderState.preferences = {
      ...DEFAULT_WANDER_SETTINGS,
      enabled: true,
    };
  });

  it("disables the last remaining content-mode switch", () => {
    wanderState.preferences = {
      ...DEFAULT_WANDER_SETTINGS,
      enabled: true,
      modes: ["timeCapsule"],
    };
    renderPage();

    const timeCapsule = modeSwitch("wander.mode.timeCapsule");
    expect(timeCapsule).toBeDisabled();
    expect(modeSwitch("wander.mode.theme")).toBeEnabled();

    fireEvent.click(timeCapsule);
    expect(wanderState.updatePreference).not.toHaveBeenCalled();
  });

  it("starts wandering when the start button is clicked", () => {
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: "wander.startNow" }));

    expect(wanderState.start).toHaveBeenCalledTimes(1);
  });

  it("converts dropdown values back to numeric wander preferences", () => {
    renderPage();

    const dropdowns = screen.getAllByRole("combobox");
    fireEvent.click(dropdowns[0]);
    fireEvent.click(screen.getAllByRole("option")[1]);
    fireEvent.click(dropdowns[1]);
    fireEvent.click(screen.getAllByRole("option")[1]);

    expect(wanderState.updatePreference).toHaveBeenCalledWith(
      "idleMinutes",
      15
    );
    expect(wanderState.updatePreference).toHaveBeenCalledWith(
      "intervalSeconds",
      5
    );
  });
});
