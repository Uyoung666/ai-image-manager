import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { UpdateChangelogHistory } from "@/components/settings/update-changelog-history";

const fixture = vi.hoisted(() => ({
  count: 12,
  navigate: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => fixture.navigate,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ i18n: { language: "zh" }, t: (key: string) => key }),
}));
vi.mock("@/content/changelogs", () => ({
  get changelogEntries() {
    return Array.from({ length: fixture.count }, (_, index) => ({
      version: `2.0.${fixture.count - index}`,
      title: { zh: `版本 ${index + 1}` },
      date: "2026-11-17",
    }));
  },
  getLocalizedText: (title: { zh: string }) => title.zh,
}));
beforeEach(() => {
  fixture.count = 12;
  fixture.navigate.mockClear();
});

it("shows five versions, reveals five more per click, and collapses back", () => {
  render(<UpdateChangelogHistory />);
  const more = () =>
    screen.getByRole("button", { name: "updateChangelogShowMore" });
  expect(screen.getAllByRole("article")).toHaveLength(5);
  expect(more()).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(more());
  expect(screen.getAllByRole("article")).toHaveLength(10);
  fireEvent.click(more());
  expect(screen.getAllByRole("article")).toHaveLength(12);
  expect(
    screen.queryByRole("button", { name: "updateChangelogShowMore" })
  ).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "updateChangelogCollapse" })
  );
  expect(screen.getAllByRole("article")).toHaveLength(5);
  expect(more()).toHaveAttribute("aria-expanded", "false");
});

it("opens the selected older version after expanding", () => {
  render(<UpdateChangelogHistory />);
  fireEvent.click(
    screen.getByRole("button", { name: "updateChangelogShowMore" })
  );
  fireEvent.click(
    within(screen.getAllByRole("article")[9]).getByRole("button")
  );
  expect(fixture.navigate).toHaveBeenCalledWith({
    to: "/whats-new",
    search: { historyCount: 10, source: "settings-update", version: "2.0.3" },
  });
});

it.each([0, 5])("omits expansion controls for %i versions", (count) => {
  fixture.count = count;
  render(<UpdateChangelogHistory />);
  expect(screen.queryAllByRole("article")).toHaveLength(count);
  expect(
    screen.queryByRole("button", { name: "updateChangelogShowMore" })
  ).toBeNull();
  expect(
    screen.queryByRole("button", { name: "updateChangelogCollapse" })
  ).toBeNull();
});
