import { fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import ToggleTheme from "@/components/toggle-theme";

const themeMocks = vi.hoisted(() => ({
  getCurrentTheme: vi.fn(() => Promise.resolve("dark")),
  getResolvedTheme: vi.fn<() => Promise<"dark" | "light">>(() =>
    Promise.resolve("dark")
  ),
  setTheme: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/actions/theme", () => themeMocks);
const errorToast = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: { error: errorToast } }));

beforeEach(() => {
  vi.clearAllMocks();
  themeMocks.getResolvedTheme.mockResolvedValue("dark");
  themeMocks.setTheme.mockResolvedValue(undefined);
});

test("renders ToggleTheme", () => {
  const { getByRole } = render(<ToggleTheme />);
  const checkbox = getByRole("checkbox");

  expect(checkbox).toBeInTheDocument();
});

test("has slider", () => {
  const { container } = render(<ToggleTheme />);
  const slider = container.querySelector(".theme-toggle-slider");

  expect(slider).toBeInTheDocument();
});

test("renders sun-moon element", () => {
  const { container } = render(<ToggleTheme />);
  const sunMoon = container.querySelector(".theme-toggle-sun-moon");

  expect(sunMoon).toBeInTheDocument();
});

test("updates the checked state after switching themes", async () => {
  const { getByRole } = render(<ToggleTheme />);
  const checkbox = getByRole("checkbox");

  await waitFor(() => expect(checkbox).toBeChecked());
  fireEvent.click(checkbox);

  await waitFor(() => {
    expect(themeMocks.setTheme).toHaveBeenCalledWith("light", {
      animateColors: false,
    });
    expect(checkbox).not.toBeChecked();
  });
});

test("switches from light to dark and synchronizes the parent", async () => {
  themeMocks.getResolvedTheme.mockResolvedValue("light");
  const onChange = vi.fn();
  const { getByRole } = render(<ToggleTheme onChange={onChange} />);
  const checkbox = getByRole("checkbox", { name: "settingsTheme" });
  await waitFor(() => expect(checkbox).not.toBeChecked());
  fireEvent.click(checkbox);
  await waitFor(() => expect(checkbox).toBeChecked());
  expect(onChange).toHaveBeenCalledExactlyOnceWith("dark");
});

test("blocks repeated input while persistence is pending", async () => {
  let finish: (() => void) | undefined;
  themeMocks.setTheme.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      })
  );
  const { getByRole } = render(<ToggleTheme />);
  const checkbox = getByRole("checkbox");
  fireEvent.click(checkbox);
  fireEvent.click(checkbox);
  await waitFor(() => expect(themeMocks.setTheme).toHaveBeenCalledOnce());
  expect(checkbox).toBeDisabled();
  finish?.();
  await waitFor(() => expect(checkbox).not.toBeDisabled());
  expect(themeMocks.setTheme).toHaveBeenCalledOnce();
});

test("keeps the original state and reports persistence failures", async () => {
  themeMocks.setTheme.mockRejectedValueOnce(new Error("IPC failed"));
  const onChange = vi.fn();
  const { getByRole } = render(<ToggleTheme onChange={onChange} />);
  const checkbox = getByRole("checkbox");
  fireEvent.click(checkbox);
  await waitFor(() => expect(errorToast).toHaveBeenCalledWith("saveFailed"));
  expect(checkbox).toBeChecked();
  expect(checkbox).not.toBeDisabled();
  expect(onChange).not.toHaveBeenCalled();
});
