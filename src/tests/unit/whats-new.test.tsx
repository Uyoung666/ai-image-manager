import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  changelogEntries,
  getChangelog,
  getLatestChangelog,
  getLocalizedText,
  hasChangelog,
} from "@/content/changelogs";
import { version as appVersion } from "../../../package.json";

const mocks = vi.hoisted(() => ({
  language: "zh",
  navigate: vi.fn(),
  openExternalLink: vi.fn(),
  source: undefined as string | undefined,
  version: "2.2.3" as string | undefined,
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => options,
  useNavigate: () => mocks.navigate,
  useSearch: () => ({ source: mocks.source, version: mocks.version }),
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
    mocks.source = undefined;
    mocks.version = appVersion;
  });

  it("registers the current release before previous versions", () => {
    expect(changelogEntries.map((entry) => entry.version)).toEqual([
      "2.2.3",
      "2.2.2",
      "2.2.1",
      "2.2.0",
      "2.1.1",
      "2.1.0",
      "2.0.0",
    ]);
    expect(getChangelog(appVersion)).toBe(getLatestChangelog());
    expect(hasChangelog(appVersion)).toBe(true);
    expect(hasChangelog("2.2.2")).toBe(true);
  });

  it.each([
    "zh",
    "en",
  ])("renders the restored 2.2.2 notes in %s", (language) => {
    const entry = getChangelog("2.2.2");
    if (!entry) {
      throw new Error("Expected restored 2.2.2 release notes");
    }
    mocks.version = entry.version;
    mocks.language = language;
    render(<WhatsNewPage />);

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      getLocalizedText(entry.title, language)
    );
    expect(screen.getAllByRole("article")).toHaveLength(
      entry.highlights.length
    );
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

  it("uses the latest release when an unknown version is selected", () => {
    const entry = getEntry();
    mocks.version = "missing-version";
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

  it("treats an unknown source like the default welcome page", () => {
    mocks.source = "unknown-source";
    render(<WhatsNewPage />);

    fireEvent.click(screen.getByRole("button", { name: "whatsNewContinue" }));
    expect(mocks.navigate).toHaveBeenCalledWith({ to: "/", replace: true });
  });

  it("returns to update settings when opened from the update history", () => {
    mocks.source = "settings-update";
    render(<WhatsNewPage />);

    expect(
      screen.getByRole("button", { name: "whatsNewBackToUpdate" })
    ).toBeInTheDocument();
    expect(
      screen.getByText("whatsNewBackToUpdateEscapeHint")
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "whatsNewBackToUpdate" })
    );
    expect(mocks.navigate).toHaveBeenCalledWith({
      replace: true,
      to: "/settings/update",
    });
  });

  it("returns to update settings when the close button is used", () => {
    mocks.source = "settings-update";
    render(<WhatsNewPage />);

    fireEvent.click(screen.getByRole("button", { name: "whatsNewClose" }));
    expect(mocks.navigate).toHaveBeenCalledWith({
      replace: true,
      to: "/settings/update",
    });
  });

  it("returns to update settings when Escape is pressed", () => {
    mocks.source = "settings-update";
    render(<WhatsNewPage />);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(mocks.navigate).toHaveBeenCalledWith({
      replace: true,
      to: "/settings/update",
    });
  });

  it("opens the full release notes on GitHub", () => {
    render(<WhatsNewPage />);

    fireEvent.click(screen.getByRole("button", { name: "whatsNewGithub" }));
    expect(mocks.openExternalLink).toHaveBeenCalledWith(
      "https://github.com/Uyoung666/ai-image-manager"
    );
  });
});
