import { fireEvent, render, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import ToggleTheme from "@/components/toggle-theme";

const themeMocks = vi.hoisted(() => ({
  getCurrentTheme: vi.fn(() => Promise.resolve("dark")),
  getResolvedTheme: vi.fn(() => Promise.resolve("dark")),
  setTheme: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/actions/theme", () => themeMocks);

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
    expect(themeMocks.setTheme).toHaveBeenCalledWith("light");
    expect(checkbox).not.toBeChecked();
  });
});
