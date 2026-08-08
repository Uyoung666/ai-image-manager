import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StartupSplash } from "@/components/startup-splash";

describe("StartupSplash", () => {
  it("renders the hamster wheel with accessible loading semantics", () => {
    render(<StartupSplash />);

    expect(screen.getByRole("status")).toHaveAttribute(
      "aria-label",
      "startupLoading"
    );
    expect(screen.getByRole("img")).toHaveAttribute(
      "aria-label",
      "startupLoading"
    );
    expect(
      document.querySelector(".wheel-and-hamster .wheel")
    ).toBeInTheDocument();
    expect(
      document.querySelector(".wheel-and-hamster .hamster__limb--fr")
    ).toBeInTheDocument();
    expect(
      document.querySelector(".wheel-and-hamster .spoke")
    ).toBeInTheDocument();
  });

  it("supports the fade-out state", () => {
    render(<StartupSplash exiting />);

    expect(screen.getByRole("status")).toHaveClass("is-exiting");
  });
});
