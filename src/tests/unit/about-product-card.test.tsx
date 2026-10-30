import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AboutCreatorCard } from "@/components/about/about-creator-card";
import { AboutProductCard } from "@/components/about/about-product-card";
import { AboutWebsiteCard } from "@/components/about/about-website-card";
import { UiPreferencesContext } from "@/contexts/ui-preferences-context";

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  navigate: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@/actions/shell", () => ({ openExternalLink: mocks.open }));
vi.mock("sonner", () => ({ toast: { error: mocks.error } }));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
}));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.open.mockResolvedValue(undefined);
  mocks.navigate.mockResolvedValue(undefined);
});
describe("about composition", () => {
  it("copies the version without triggering the easter egg", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: write },
    });
    const click = vi.fn();
    render(
      <AboutProductCard
        easterEggFound={false}
        onVersionClick={click}
        version="2.2.4"
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "aboutCopyVersion" }));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("copied")
    );
    expect(write).toHaveBeenCalledWith("AI Image Manager 2.2.4");
    expect(click).not.toHaveBeenCalled();
    write.mockRejectedValue(new Error("denied"));
    fireEvent.click(screen.getByRole("button", { name: "aboutCopyVersion" }));
    await waitFor(() => expect(mocks.error).toHaveBeenCalledWith("copyFailed"));
  });
  it("supports hover, explicit collapse, focus and escape", () => {
    render(<AboutCreatorCard />);
    const card = screen.getByTestId("about-creator");
    const cover = screen.getByRole("button", { name: "aboutCreatorToggle" });
    fireEvent.pointerEnter(card);
    expect(card).toHaveAttribute("data-expanded", "true");
    fireEvent.click(cover);
    expect(card).toHaveAttribute("data-expanded", "false");
    fireEvent.click(cover);
    expect(card).toHaveAttribute("data-expanded", "true");
    fireEvent.keyDown(cover, { key: "Escape" });
    expect(card).toHaveAttribute("data-expanded", "false");
    fireEvent.pointerLeave(card);
    fireEvent.focus(cover);
    expect(card).toHaveAttribute("data-expanded", "true");
  });
  it("keeps content available with reduced motion", () => {
    render(
      <UiPreferencesContext.Provider
        value={{ reduceMotion: true, setReduceMotion: async () => undefined }}
      >
        <AboutCreatorCard />
      </UiPreferencesContext.Provider>
    );
    expect(screen.getByTestId("about-creator")).toHaveAttribute(
      "data-expanded",
      "true"
    );
    expect(
      screen.getByRole("button", { name: "aboutCreatorToggle" })
    ).toBeDisabled();
  });
  it("routes feedback and reports external link failure", async () => {
    render(<AboutCreatorCard />);
    fireEvent.click(
      screen.getByRole("button", { name: "diagnosticsReportProblem" })
    );
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: "/settings/diagnostics",
    });
    mocks.open.mockRejectedValue(new Error("failed"));
    fireEvent.click(screen.getByRole("button", { name: "GitHub" }));
    await waitFor(() =>
      expect(mocks.error).toHaveBeenCalledWith("aboutOpenFailed")
    );
  });
  it("keeps website entry working when previews fail", () => {
    const { container } = render(<AboutWebsiteCard />);
    for (const image of container.querySelectorAll("img")) {
      fireEvent.error(image);
    }
    fireEvent.click(
      screen.getByRole("button", { name: "settingsVisitWebsite" })
    );
    expect(mocks.open).toHaveBeenCalledWith(
      "https://ai-image-manager.uyoungvision.cn/"
    );
    expect(container.querySelectorAll(".about-site-fallback")).toHaveLength(2);
  });
});
