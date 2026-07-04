import { render } from "@testing-library/react";
import { expect, test } from "vitest";
import ToggleTheme from "@/components/toggle-theme";

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
