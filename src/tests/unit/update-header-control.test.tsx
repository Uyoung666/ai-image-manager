import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { UpdateHeaderControl } from "@/components/update-header-control";
import { translateUpdate, updateUiFixture } from "../helpers/update-ui";

const navigate = vi.hoisted(() => vi.fn());
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
vi.mock("@/ipc/manager", () => ({ ipc: { client: {} } }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: translateUpdate, i18n: { language: "en" } }),
}));
beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

it("opens details without navigation and keeps an open result until the user closes it", async () => {
  const fixture = updateUiFixture({
    phase: "downloading",
    version: "2.2.4",
    percent: 42,
  });
  fixture.render(<UpdateHeaderControl />);
  const trigger = await screen.findByTestId("update-header-control");
  expect(trigger).toHaveAttribute(
    "aria-label",
    "updateDownloading · 2.2.4 · 42%"
  );
  fireEvent.click(trigger);
  const details = await screen.findByTestId("update-details");
  expect(details).toBeVisible();
  expect(navigate).not.toHaveBeenCalled();
  act(() => fixture.emit({ phase: "up-to-date" }));
  expect(details).toBeVisible();
  expect(within(details).getByText("updateUpToDate")).toBeVisible();
  fireEvent.keyDown(details, { key: "Escape" });
  await waitFor(() =>
    expect(
      screen.queryByTestId("update-header-control")
    ).not.toBeInTheDocument()
  );
});

it("keeps quiet at idle and routes the details settings action to the full page", async () => {
  const fixture = updateUiFixture();
  fixture.render(<UpdateHeaderControl />);
  await waitFor(() =>
    expect(fixture.store.getSnapshot().preferencesReady).toBe(true)
  );
  expect(screen.queryByTestId("update-header-control")).not.toBeInTheDocument();
  act(() => fixture.emit({ phase: "downloaded", version: "2.2.4" }));
  fireEvent.click(screen.getByTestId("update-header-control"));
  fireEvent.click(
    await screen.findByRole("button", { name: "updateViewSettings" })
  );
  expect(navigate).toHaveBeenCalledWith({ to: "/settings/update" });
  expect(fixture.store.getSnapshot().detailsOpen).toBe(false);
});

it("does not automatically open on a stage change, and closing never cancels a task", async () => {
  const fixture = updateUiFixture({ phase: "installing", version: "2.2.4" });
  fixture.render(<UpdateHeaderControl />);
  const trigger = await screen.findByTestId("update-header-control");
  expect(screen.queryByTestId("update-details")).not.toBeInTheDocument();
  fireEvent.click(trigger);
  act(() => fixture.emit({ phase: "restarting", version: "2.2.4" }));
  expect(screen.getByTestId("update-details")).toBeVisible();
  fireEvent.keyDown(screen.getByTestId("update-details"), { key: "Escape" });
  await waitFor(() =>
    expect(screen.queryByTestId("update-details")).not.toBeInTheDocument()
  );
  expect(fixture.store.getSnapshot().status.phase).toBe("restarting");
});
