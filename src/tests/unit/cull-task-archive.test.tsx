import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CullArchiveButton } from "@/components/CullArchiveButton";
import { CULL_ARCHIVE_CHANGED } from "@/hooks/use-cull-task-archive";

const mocks = vi.hoisted(() => ({
  project: vi.fn(),
  library: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));
vi.mock("@/actions/cull", () => ({
  cullActions: { archiveSession: mocks.library },
}));
vi.mock("@/actions/shooting-projects", () => ({
  shootingProjectActions: { archive: mocks.project },
}));
vi.mock("sonner", () => ({
  toast: { success: mocks.success, error: mocks.error, info: mocks.info },
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.project.mockResolvedValue({});
  mocks.library.mockResolvedValue({});
});

describe("shared culling archive action", () => {
  it("archives immediately and undo still restores it after unmount", async () => {
    const onChanged = vi.fn();
    const changed = vi.fn();
    window.addEventListener(CULL_ARCHIVE_CHANGED, changed);
    try {
      const view = render(
        <CullArchiveButton
          onChanged={onChanged}
          task={{ kind: "library", id: 41, name: "Finished" }}
        />
      );
      fireEvent.click(
        screen.getByRole("button", { name: "cullProject.archive.archive" })
      );
      await waitFor(() => expect(mocks.success).toHaveBeenCalledOnce());
      expect(mocks.library).toHaveBeenCalledWith({
        sessionId: 41,
        archived: true,
      });
      expect(onChanged).toHaveBeenCalledOnce();
      expect(mocks.success.mock.calls[0][1]).toMatchObject({
        id: "cull-task-archive",
        duration: 8000,
      });
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      const undo = mocks.success.mock.calls[0][1].action.onClick;
      view.unmount();
      await act(async () => {
        await undo();
      });
      expect(mocks.library).toHaveBeenLastCalledWith({
        sessionId: 41,
        archived: false,
      });
      expect(changed).toHaveBeenCalledTimes(2);
    } finally {
      window.removeEventListener(CULL_ARCHIVE_CHANGED, changed);
    }
  });

  it("restores folder projects and prevents an older undo from overriding a later action", async () => {
    const task = {
      kind: "project" as const,
      id: "archive-project",
      name: "Shoot",
      archivedAt: 123,
    };
    const view = render(<CullArchiveButton task={task} />);
    fireEvent.click(
      screen.getByRole("button", { name: "cullProject.archive.restore" })
    );
    await waitFor(() => expect(mocks.success).toHaveBeenCalledTimes(1));
    expect(mocks.project).toHaveBeenCalledWith({
      projectId: task.id,
      archived: false,
    });
    const oldUndo = mocks.success.mock.calls[0][1].action.onClick;
    view.rerender(<CullArchiveButton task={{ ...task, archivedAt: null }} />);
    fireEvent.click(
      screen.getByRole("button", { name: "cullProject.archive.archive" })
    );
    await waitFor(() => expect(mocks.success).toHaveBeenCalledTimes(2));
    expect(mocks.success.mock.calls.map((call) => call[1].id)).toEqual([
      "cull-task-archive",
      "cull-task-archive",
    ]);
    await act(async () => {
      await oldUndo();
    });
    expect(mocks.project).toHaveBeenCalledTimes(2);
    expect(mocks.info).toHaveBeenCalledWith("cullProject.archive.undoExpired");
  });

  it("keeps the task in place and offers no success or undo when saving fails", async () => {
    const onChanged = vi.fn();
    mocks.library.mockRejectedValue(new Error("database unavailable"));
    render(
      <CullArchiveButton
        onChanged={onChanged}
        task={{ kind: "library", id: 42, name: "Shoot" }}
      />
    );
    fireEvent.click(
      screen.getByRole("button", { name: "cullProject.archive.archive" })
    );
    await waitFor(() =>
      expect(mocks.error).toHaveBeenCalledWith("cullActionFailed")
    );
    expect(onChanged).not.toHaveBeenCalled();
    expect(mocks.success).not.toHaveBeenCalled();
    expect(screen.getByRole("button")).toBeEnabled();
  });
});
