import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CullStartDialog } from "@/components/CullStartDialog";
import { ipc } from "@/ipc/manager";

vi.mock("@/ipc/manager", () => ({
  ipc: {
    client: {
      cull: {
        createSession: vi.fn(),
      },
    },
  },
}));

describe("CullStartDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a curate session with the selected strategy", async () => {
    vi.mocked(ipc.client.cull.createSession).mockResolvedValue({
      completedAt: null,
      completedComparisons: 0,
      createdAt: Date.now(),
      id: 42,
      mode: "curate",
      name: "Trip",
      pkMode: "standard",
      sortStrategy: "similarity",
      status: "active",
      totalPhotos: 3,
    });
    const onCreated = vi.fn();
    render(
      <CullStartDialog
        defaultName="Trip"
        onClose={vi.fn()}
        onCreated={onCreated}
        open
        photoIds={[1, 2, 3]}
      />
    );

    fireEvent.click(screen.getByText("cullModeCurate"));
    fireEvent.click(screen.getByText("cullSortBySimilarity"));
    fireEvent.click(screen.getByText("cullStart"));

    await waitFor(() => {
      expect(ipc.client.cull.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: "curate",
          photoIds: [1, 2, 3],
          sortStrategy: "similarity",
        })
      );
      expect(onCreated).toHaveBeenCalledWith(42);
    });
  });

  it("does not allow creating a session with fewer than two photos", () => {
    render(
      <CullStartDialog
        onClose={vi.fn()}
        onCreated={vi.fn()}
        open
        photoIds={[1]}
      />
    );
    expect(screen.getByText("cullStart")).toBeDisabled();
  });
});
