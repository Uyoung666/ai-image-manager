import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AiProgressBar } from "@/components/AiProgressBar";
import { ipc } from "@/ipc/manager";

vi.mock("@/ipc/manager", () => ({
  ipc: {
    client: {
      photos: {
        cancelAiIndexing: vi.fn(),
        getAiProgress: vi.fn(),
        pauseAiIndexing: vi.fn(),
        resumeAiIndexing: vi.fn(),
        startAiIndexing: vi.fn(),
      },
    },
  },
}));

describe("AiProgressBar", () => {
  it("renders resume controls from backend paused state after mount", async () => {
    vi.mocked(ipc.client.photos.getAiProgress).mockResolvedValue({
      controlState: "paused",
      currentFile: "paused at 3/10",
      isActive: false,
      isModelLoaded: true,
      isPaused: true,
      phase: "embedding",
      processed: 3,
      runId: 1,
      total: 10,
    });

    render(<AiProgressBar />);

    await waitFor(() => {
      expect(screen.getByText("aiResume")).toBeInTheDocument();
    });
    expect(screen.getByText("cancel")).toBeInTheDocument();
    expect(screen.queryByText("aiPause")).not.toBeInTheDocument();
  });
});
