import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { BatchTagDialog } from "@/components/BatchTagDialog";
import { queryClient } from "@/providers/QueryProvider";

const actions = vi.hoisted(() => ({
  list: vi.fn(),
  summary: vi.fn(),
  apply: vi.fn(),
  undo: vi.fn(),
}));
const toast = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
  loading: vi.fn(),
  dismiss: vi.fn(),
}));
vi.mock("@/actions/photo-tags", () => ({ photoTagActions: actions }));
vi.mock("sonner", () => ({ toast }));
vi.mock("@/providers/QueryProvider", () => ({
  queryClient: { invalidateQueries: vi.fn() },
}));
beforeEach(() => {
  vi.clearAllMocks();
  actions.list.mockResolvedValue([
    { id: 1, name: "Partial" },
    { id: 2, name: "All" },
    { id: 3, name: "None" },
  ]);
  actions.summary.mockResolvedValue({
    counts: new Map([
      [1, 1],
      [2, 2],
    ]),
    total: 2,
  });
  actions.apply.mockResolvedValue({
    changed: 3,
    processed: 2,
    failed: 0,
    operationId: "operation",
  });
  actions.undo.mockResolvedValue({ restored: 3, skipped: 0, expired: false });
});
it("shows mixed ownership and applies only explicit changes", async () => {
  const close = vi.fn();
  render(<BatchTagDialog onClose={close} photoIds={[1, 2]} />);
  const partial = await screen.findByRole("checkbox", { name: "Partial" });
  expect(partial).toHaveAttribute("aria-checked", "mixed");
  expect(screen.getByRole("checkbox", { name: "All" })).toBeChecked();
  expect(screen.getByRole("checkbox", { name: "None" })).not.toBeChecked();
  fireEvent.click(partial);
  fireEvent.click(screen.getByRole("checkbox", { name: "All" }));
  fireEvent.click(screen.getByRole("button", { name: "应用标签修改" }));
  await waitFor(() =>
    expect(actions.apply).toHaveBeenCalledWith(
      [1, 2],
      [1],
      [2],
      expect.any(Function)
    )
  );
  expect(close).toHaveBeenCalledTimes(1);
  const options = toast.success.mock.calls[0][1];
  expect(options.duration).toBe(10_000);
  await options.action.onClick();
  expect(actions.undo).toHaveBeenCalledWith("operation");
  expect(vi.mocked(queryClient.invalidateQueries).mock.calls).toEqual([
    [{ queryKey: ["tags"] }],
    [{ queryKey: ["albums"] }],
    [{ queryKey: ["tags"] }],
    [{ queryKey: ["albums"] }],
  ]);
});
it("does not refresh gallery pages or tag scopes when no relationships changed", async () => {
  actions.apply.mockResolvedValue({
    changed: 0,
    processed: 2,
    failed: 0,
    operationId: "none",
  });
  const changed = vi.fn();
  window.addEventListener("tags-changed", changed);
  try {
    const close = vi.fn();
    render(<BatchTagDialog onClose={close} photoIds={[1, 2]} />);
    fireEvent.click(await screen.findByRole("checkbox", { name: "None" }));
    fireEvent.click(screen.getByRole("button", { name: "应用标签修改" }));
    await waitFor(() => expect(close).toHaveBeenCalled());
    expect(queryClient.invalidateQueries).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener("tags-changed", changed);
  }
});
it("cycles a partial tag through add, remove and keep and retains hidden draft changes", async () => {
  render(<BatchTagDialog onClose={vi.fn()} photoIds={[1, 2]} />);
  const partial = await screen.findByRole("checkbox", { name: "Partial" });
  fireEvent.click(partial);
  expect(partial).toBeChecked();
  fireEvent.click(partial);
  expect(partial).not.toBeChecked();
  fireEvent.click(partial);
  expect(partial).toHaveAttribute("aria-checked", "mixed");
  expect(screen.getByRole("button", { name: "应用标签修改" })).toBeDisabled();
  const none = screen.getByRole("checkbox", { name: "None" });
  fireEvent.click(none);
  fireEvent.click(none);
  expect(screen.getByRole("button", { name: "应用标签修改" })).toBeDisabled();
  fireEvent.click(none);
  fireEvent.change(screen.getByRole("textbox", { name: "搜索已有标签" }), {
    target: { value: "All" },
  });
  expect(
    screen.queryByRole("checkbox", { name: "None" })
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "应用标签修改" }));
  await waitFor(() =>
    expect(actions.apply).toHaveBeenCalledWith(
      [1, 2],
      [3],
      [],
      expect.any(Function)
    )
  );
});
it("offers retry for a failed ownership request", async () => {
  actions.summary.mockRejectedValueOnce(new Error("unavailable"));
  render(<BatchTagDialog onClose={vi.fn()} photoIds={[1, 2]} />);
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "retry" }));
  expect(
    await screen.findByRole("checkbox", { name: "Partial" })
  ).toBeVisible();
});
