import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  changelogEntries,
  getChangelog,
  getLatestChangelog,
  getLocalizedText,
  hasChangelog,
} from "@/content/changelogs";

const mocks = vi.hoisted(() => ({
  language: "zh",
  navigate: vi.fn(),
  openExternalLink: vi.fn(),
  version: "2.1.0" as string | undefined,
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => options,
  useNavigate: () => mocks.navigate,
  useSearch: () => ({ version: mocks.version }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    i18n: { language: mocks.language },
    t: (key: string) => key,
  }),
}));

vi.mock("@/actions/shell", () => ({
  openExternalLink: mocks.openExternalLink,
}));

import { WhatsNewPage } from "@/routes/whats-new";

function getEntry() {
  const entry = getLatestChangelog();
  if (!entry) {
    throw new Error("Expected a changelog entry for the test suite");
  }
  return entry;
}

describe("WhatsNewPage", () => {
  beforeEach(() => {
    mocks.language = "zh";
    mocks.navigate.mockReset();
    mocks.openExternalLink.mockReset();
    mocks.version = "2.1.0";
  });

  it("registers the current release before previous versions", () => {
    expect(changelogEntries.map((entry) => entry.version)).toEqual([
      "2.1.0",
      "2.0.0",
    ]);
    expect(getChangelog("2.1.0")).toBe(getLatestChangelog());
    expect(hasChangelog("2.1.0")).toBe(true);
  });

  it("renders localized highlights and continues to the gallery", () => {
    const entry = getEntry();
    const { container } = render(<WhatsNewPage />);

    expect(
      screen.getByText(getLocalizedText(entry.title, "zh"))
    ).toBeInTheDocument();
    expect(
      screen.getByText(getLocalizedText(entry.highlights[0].title, "zh"))
    ).toBeInTheDocument();
    expect(screen.getAllByRole("article")).toHaveLength(
      entry.highlights.length
    );
    expect(
      container.querySelectorAll(
        ".whats-new-brand-icon, .whats-new-release-visual-image"
      )
    ).toHaveLength(2);
    expect(
      container.querySelectorAll(".whats-new-highlight-arrow")
    ).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "whatsNewContinue" }));
    expect(mocks.navigate).toHaveBeenCalledWith({ to: "/", replace: true });
  });

  it("uses the latest release when no version is selected", () => {
    const entry = getEntry();
    mocks.version = undefined;
    render(<WhatsNewPage />);

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      getLocalizedText(entry.title, "zh")
    );
  });

  it("switches the page content to English", () => {
    const entry = getEntry();
    mocks.language = "en";
    render(<WhatsNewPage />);

    expect(
      screen.getByText(getLocalizedText(entry.title, "en"))
    ).toBeInTheDocument();
    expect(
      screen.getByText(getLocalizedText(entry.highlights[0].title, "en"))
    ).toBeInTheDocument();
  });

  it("continues when Escape is pressed", () => {
    render(<WhatsNewPage />);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(mocks.navigate).toHaveBeenCalledWith({ to: "/", replace: true });
  });

  it("closes from the top bar", () => {
    render(<WhatsNewPage />);

    fireEvent.click(screen.getByRole("button", { name: "whatsNewClose" }));
    expect(mocks.navigate).toHaveBeenCalledWith({ to: "/", replace: true });
  });

  it("opens the full release notes on GitHub", () => {
    render(<WhatsNewPage />);

    fireEvent.click(screen.getByRole("button", { name: "whatsNewGithub" }));
    expect(mocks.openExternalLink).toHaveBeenCalledWith(
      "https://github.com/Uyoung666/ai-image-manager"
    );
  });
});
