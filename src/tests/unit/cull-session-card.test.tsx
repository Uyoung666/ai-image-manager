import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CullTaskCard } from "@/components/CullTaskCard";
import type { CullTaskSummary } from "@/types/cull";

const task: CullTaskSummary = {
  kind: "library",
  id: 1,
  name: "植物园 - 对决模式",
  createdAt: 1,
  workflow: "duel",
  photoCount: 0,
  keptCount: 0,
  stages: [],
};

describe("CullTaskCard", () => {
  it("keeps action buttons clickable when it is the only card", () => {
    const onClick = vi.fn();
    const onDelete = vi.fn();
    const onDuplicate = vi.fn();
    const onRename = vi.fn();

    render(
      <CullTaskCard
        onDelete={onDelete}
        onDuplicate={onDuplicate}
        onOpen={onClick}
        onRename={onRename}
        task={task}
      />
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "cullProject.archive.moreTaskActions",
      })
    );
    fireEvent.click(screen.getByRole("button", { name: "rename" }));
    fireEvent.click(
      screen.getByRole("button", {
        name: "cullProject.archive.moreTaskActions",
      })
    );
    fireEvent.click(screen.getByRole("button", { name: "duplicate" }));
    fireEvent.click(
      screen.getByRole("button", {
        name: "cullProject.archive.moreTaskActions",
      })
    );
    fireEvent.click(screen.getByRole("button", { name: "delete" }));

    expect(onRename).toHaveBeenCalledTimes(1);
    expect(onDuplicate).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe("task progress and source warnings", () => {
  it("keeps actual coverage when a curate session ends early", () => {
    render(
      <CullTaskCard
        onDelete={vi.fn()}
        onOpen={vi.fn()}
        onRename={vi.fn()}
        task={{
          ...task,
          workflow: "curate",
          photoCount: 3,
          keptCount: 1,
          stages: [
            {
              mode: "curate",
              status: "completed",
              processedCount: 1,
              totalPhotos: 3,
              comparisons: 99,
              progress: 33,
            },
          ],
        }}
      />
    );
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "33"
    );
    expect(
      screen.getByText("cullProject.task.ended", { exact: false })
    ).toBeInTheDocument();
  });

  it("distinguishes waiting for PK from having fewer than two candidates", () => {
    const hybrid: CullTaskSummary = {
      ...task,
      workflow: "hybrid",
      photoCount: 3,
      keptCount: 1,
      stages: [
        {
          mode: "curate",
          status: "completed",
          processedCount: 3,
          totalPhotos: 3,
          comparisons: 0,
          progress: 100,
        },
        {
          mode: "duel",
          status: "not-started",
          processedCount: 0,
          totalPhotos: 1,
          comparisons: 0,
          progress: 0,
        },
      ],
    };
    const props = { onOpen: vi.fn(), onRename: vi.fn(), onDelete: vi.fn() };
    const view = render(<CullTaskCard task={hybrid} {...props} />);
    expect(
      screen.getByText("cullProject.task.resultsReady", { exact: false })
    ).toBeInTheDocument();
    view.rerender(
      <CullTaskCard task={{ ...hybrid, keptCount: 2 }} {...props} />
    );
    expect(
      screen.getByText("cullProject.task.waitingPk", { exact: false })
    ).toBeInTheDocument();
  });

  it("keeps an offline empty task openable and reports preparation separately", () => {
    const onOpen = vi.fn();
    render(
      <CullTaskCard
        onDelete={vi.fn()}
        onOpen={onOpen}
        onRename={vi.fn()}
        task={{ ...task, sourceStatus: "offline", scanStatus: "failed" }}
      />
    );
    expect(screen.getByText("cullProject.task.noPhotos")).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.getByTestId("cull-task-warning")).toHaveTextContent(
      "shootingProject.sourceOffline"
    );
    expect(screen.getByTestId("cull-task-warning")).toHaveTextContent(
      "cullProject.task.scanWarning"
    );
    fireEvent.click(screen.getAllByRole("button")[0]);
    expect(onOpen).toHaveBeenCalledOnce();
  });
});
