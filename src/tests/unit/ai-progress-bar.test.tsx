import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AiProgressBar } from "@/components/AiProgressBar";
import { ipc } from "@/ipc/manager";

vi.mock("@/ipc/manager", () => ({
  ipc: {
    client: {
      photos: {
        cancelAiIndexing: vi.fn(),
        getAiProgress: vi.fn(),
        getAiStatus: vi.fn(),
        pauseAiIndexing: vi.fn(),
        resumeAiIndexing: vi.fn(),
        startAiIndexing: vi.fn(),
        resetAiIndex: vi.fn(),
      },
    },
  },
}));

const idle = {
  controlState: "idle" as const,
  currentFile: "",
  isActive: false,
  isPaused: false,
  isModelLoaded: false,
  phase: "idle" as const,
  processed: 0,
  runId: 0,
  total: 8,
};

const readyStatus = {
  coverageState: "unavailable" as const,
  embeddingProgress: { processed: 0, total: 8, phase: "idle" },
  hasVectors: false,
  indexedPhotos: 0,
  indexReady: false,
  isEmbedding: false,
  model: "loading" as const,
  pendingPhotos: 8,
  rebuildRequired: false,
  totalPhotos: 8,
  translationState: "ready" as const,
  vectorCompatibility: "empty" as const,
  vectorCount: 0,
  vectorDB: "ready" as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(ipc.client.photos.getAiProgress).mockResolvedValue(idle);
  vi.mocked(ipc.client.photos.getAiStatus).mockResolvedValue(readyStatus);
  vi.mocked(ipc.client.photos.resetAiIndex).mockResolvedValue({
    success: true,
  });
  vi.mocked(ipc.client.photos.startAiIndexing).mockResolvedValue({
    started: true,
  });
});

describe("AiProgressBar", () => {
  it.each([
    "error",
    "complete",
  ] as const)("shows per-photo failures without model/network advice: %s", async (phase) => {
    vi.mocked(ipc.client.photos.getAiProgress).mockResolvedValue({
      ...idle,
      phase,
      processed: phase === "complete" ? 1 : 0,
      failureSummary: {
        failed: 7,
        decodeFailed: 7,
        modelFailed: 0,
        inferenceFailed: 0,
      },
      error: "AI indexing: image decoding failed",
    });
    render(<AiProgressBar />);
    expect(
      await screen.findByText("aiPhotoFailureSummary")
    ).toBeInTheDocument();
    expect(screen.queryByText("aiMirrorHint")).toBeNull();
    expect(screen.queryByText("aiNetworkErrorHint")).toBeNull();
  });

  it.each([
    "empty",
    "matching",
  ] as const)("hides the settings migration entry for compatible status: %s", async (compatibility) => {
    vi.mocked(ipc.client.photos.getAiStatus).mockResolvedValue({
      ...readyStatus,
      vectorCompatibility: compatibility,
    });
    render(<AiProgressBar migrationOnly />);
    await waitFor(() =>
      expect(ipc.client.photos.getAiStatus).toHaveBeenCalled()
    );
    expect(screen.queryByRole("button", { name: "aiStartIndex" })).toBeNull();
    expect(screen.queryByRole("button", { name: "aiRebuildIndex" })).toBeNull();
  });

  it("hides the settings migration entry for a resumable current build", async () => {
    vi.mocked(ipc.client.photos.getAiStatus).mockResolvedValue({
      ...readyStatus,
      vectorCompatibility: "matching",
      vectorBuildState: "building",
      coverageState: "partial",
    });
    render(<AiProgressBar migrationOnly />);
    await waitFor(() =>
      expect(ipc.client.photos.getAiStatus).toHaveBeenCalled()
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText("aiIndexRebuildRequired")).toBeNull();
  });

  it("explains an ordinary start refusal without resetting vectors", async () => {
    vi.mocked(ipc.client.photos.startAiIndexing).mockResolvedValue({
      busy: true,
      started: false,
      state: "running",
    });
    render(<AiProgressBar />);
    fireEvent.click(
      await screen.findByRole("button", { name: "aiStartIndex" })
    );
    expect(await screen.findByText("aiIndexBusy")).toBeInTheDocument();
    expect(ipc.client.photos.resetAiIndex).not.toHaveBeenCalled();
  });

  it("clears an old backend error once indexing completes", async () => {
    vi.mocked(ipc.client.photos.getAiProgress)
      .mockResolvedValueOnce({
        ...idle,
        phase: "error",
        error: "Internal provider failure",
      })
      .mockResolvedValue({ ...idle, phase: "complete", processed: 8 });
    render(<AiProgressBar />);
    const retry = await screen.findByRole("button", { name: "aiRetry" });
    expect(screen.queryByText("Internal provider failure")).toBeNull();
    fireEvent.click(retry);
    expect(
      await screen.findByRole("button", { name: "aiIndexNewPhotos" })
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "aiRetry" })).toBeNull();
  });

  const requireRebuild = () => {
    vi.mocked(ipc.client.photos.getAiStatus).mockResolvedValue({
      ...readyStatus,
      rebuildRequired: true,
      vectorCompatibility: "fingerprint-mismatch",
      vectorDB: "error",
    });
  };

  it("detects an old index while idle without loading the model", async () => {
    requireRebuild();
    render(<AiProgressBar />);
    expect(
      await screen.findByRole("button", { name: "aiRebuildIndex" })
    ).toBeEnabled();
    expect(screen.getByText("aiIndexRebuildDescription")).toBeInTheDocument();
    expect(ipc.client.photos.getAiStatus).toHaveBeenCalledWith({
      loadModel: false,
    });
    expect(ipc.client.photos.resetAiIndex).not.toHaveBeenCalled();
    expect(ipc.client.photos.startAiIndexing).not.toHaveBeenCalled();
  });

  it("starts only after an explicit successful reset and prevents duplicate clicks", async () => {
    requireRebuild();
    let resolveReset: ((result: { success: true }) => void) | undefined;
    vi.mocked(ipc.client.photos.resetAiIndex).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveReset = resolve;
        })
    );
    render(<AiProgressBar />);
    const button = await screen.findByRole("button", {
      name: "aiRebuildIndex",
    });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent("aiRepairingIndex");
    expect(screen.getByText("aiIndexRebuildPreparing")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveAttribute("aria-busy", "true");
    expect(ipc.client.photos.resetAiIndex).toHaveBeenCalledOnce();
    expect(ipc.client.photos.startAiIndexing).not.toHaveBeenCalled();
    resolveReset?.({ success: true });
    await waitFor(() =>
      expect(ipc.client.photos.startAiIndexing).toHaveBeenCalledOnce()
    );
  });

  it.each([
    {
      success: false as const,
      error: "vector reset failed",
      expected: "aiIndexRebuildFailed",
    },
    { success: false as const, busy: true, expected: "aiIndexBusy" },
  ])("does not start after reset failure or busy state: $expected", async ({
    expected,
    ...result
  }) => {
    requireRebuild();
    vi.mocked(ipc.client.photos.resetAiIndex).mockResolvedValue(result);
    render(<AiProgressBar />);
    fireEvent.click(
      await screen.findByRole("button", { name: "aiRebuildIndex" })
    );
    expect(await screen.findByText(expected)).toBeInTheDocument();
    expect(ipc.client.photos.startAiIndexing).not.toHaveBeenCalled();
  });

  it.each([
    false,
    true,
  ])("keeps rebuild failure and retry visible after polling reports a compatible store (migrationOnly=%s)", async (migrationOnly) => {
    requireRebuild();
    vi.mocked(ipc.client.photos.resetAiIndex).mockResolvedValue({
      success: false,
      error: "ENOTEMPTY: directory not empty, rmdir '/private/vectors'",
    });
    render(<AiProgressBar migrationOnly={migrationOnly} />);
    const button = await screen.findByRole("button", {
      name: "aiRebuildIndex",
    });
    vi.mocked(ipc.client.photos.getAiStatus).mockResolvedValue(readyStatus);
    fireEvent.click(button);

    expect(await screen.findByText("aiIndexRebuildFailed")).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "aiRebuildIndex" })
      ).toBeEnabled()
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "aiIndexRebuildRetryHint"
    );
    expect(screen.queryByText("aiIndexRebuildDescription")).toBeNull();
    expect(screen.getByRole("alert")).not.toHaveTextContent("ENOTEMPTY");
    expect(ipc.client.photos.startAiIndexing).not.toHaveBeenCalled();
  });

  it("keeps rebuild failure visible when the progress refresh also fails", async () => {
    requireRebuild();
    vi.mocked(ipc.client.photos.resetAiIndex).mockRejectedValue(
      new Error("reset IPC disconnected")
    );
    render(<AiProgressBar />);
    const button = await screen.findByRole("button", {
      name: "aiRebuildIndex",
    });
    vi.mocked(ipc.client.photos.getAiProgress).mockRejectedValue(
      new Error("progress IPC disconnected")
    );
    fireEvent.click(button);

    expect(await screen.findByText("aiIndexRebuildFailed")).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "aiRebuildIndex" })
      ).toBeEnabled()
    );
    expect(screen.getByText("aiIndexRebuildRetryHint")).toBeInTheDocument();
    expect(ipc.client.photos.startAiIndexing).not.toHaveBeenCalled();
  });

  it("clears a failed rebuild notice only after a retry starts indexing", async () => {
    requireRebuild();
    vi.mocked(ipc.client.photos.resetAiIndex)
      .mockResolvedValueOnce({ success: false, error: "reset failed" })
      .mockResolvedValue({ success: true });
    render(<AiProgressBar />);
    fireEvent.click(
      await screen.findByRole("button", { name: "aiRebuildIndex" })
    );
    expect(await screen.findByText("aiIndexRebuildFailed")).toBeInTheDocument();
    const retry = await screen.findByRole("button", { name: "aiRebuildIndex" });
    await waitFor(() => expect(retry).toBeEnabled());
    vi.mocked(ipc.client.photos.getAiStatus).mockResolvedValue(readyStatus);
    vi.mocked(ipc.client.photos.getAiProgress).mockResolvedValue({
      ...idle,
      controlState: "running",
      isActive: true,
      phase: "embedding",
      processed: 1,
    });
    fireEvent.click(retry);

    expect(
      await screen.findByRole("button", { name: "aiPause" })
    ).toBeEnabled();
    expect(screen.queryByText("aiIndexRebuildFailed")).toBeNull();
    expect(screen.queryByText("aiIndexRebuildRetryHint")).toBeNull();
    expect(ipc.client.photos.resetAiIndex).toHaveBeenCalledTimes(2);
    expect(ipc.client.photos.startAiIndexing).toHaveBeenCalledOnce();
  });

  it.each([
    false,
    true,
  ])("keeps controls available when another task changes state during a refused rebuild (paused=%s)", async (paused) => {
    requireRebuild();
    vi.mocked(ipc.client.photos.resetAiIndex).mockResolvedValue({
      success: false,
      busy: true,
    });
    render(<AiProgressBar />);
    const button = await screen.findByRole("button", {
      name: "aiRebuildIndex",
    });
    vi.mocked(ipc.client.photos.getAiProgress).mockResolvedValue({
      ...idle,
      controlState: paused ? "paused" : "running",
      isActive: !paused,
      isPaused: paused,
      phase: "embedding",
      processed: 1,
    });
    vi.mocked(ipc.client.photos.getAiStatus).mockResolvedValue(readyStatus);
    fireEvent.click(button);

    expect(
      await screen.findByRole("button", {
        name: paused ? "aiResume" : "aiPause",
      })
    ).toBeEnabled();
    expect(screen.getByRole("alert")).toHaveTextContent("aiIndexBusy");
    expect(ipc.client.photos.startAiIndexing).not.toHaveBeenCalled();
  });

  it("keeps rebuilding disabled while another AI operation is paused", async () => {
    requireRebuild();
    vi.mocked(ipc.client.photos.getAiProgress).mockResolvedValue({
      ...idle,
      controlState: "paused",
    });
    render(<AiProgressBar />);
    expect(
      await screen.findByRole("button", { name: "aiRebuildIndex" })
    ).toBeDisabled();
    expect(ipc.client.photos.resetAiIndex).not.toHaveBeenCalled();
  });

  it("does not offer rebuilding for a resumable build or partial compatible index", async () => {
    vi.mocked(ipc.client.photos.getAiStatus).mockResolvedValue({
      ...readyStatus,
      coverageState: "partial",
      vectorBuildState: "building",
      vectorCompatibility: "matching",
    });
    vi.mocked(ipc.client.photos.getAiProgress).mockResolvedValue({
      ...idle,
      phase: "complete",
      processed: 8,
    });
    render(<AiProgressBar />);
    expect(
      await screen.findByText("aiIndexBuildIncomplete")
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "aiRebuildIndex" })).toBeNull();
    expect(screen.queryByText("100%")).toBeNull();
    expect(ipc.client.photos.resetAiIndex).not.toHaveBeenCalled();
  });

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

  it.each([
    { label: "aiPause", paused: false, action: "pauseAiIndexing" },
    { label: "aiResume", paused: true, action: "resumeAiIndexing" },
    { label: "cancel", paused: true, action: "cancelAiIndexing" },
  ] as const)("preserves $label controls without resetting the index", async ({
    action,
    label,
    paused,
  }) => {
    vi.mocked(ipc.client.photos.getAiProgress).mockResolvedValue({
      ...idle,
      controlState: paused ? "paused" : "running",
      isActive: !paused,
      isModelLoaded: true,
      isPaused: paused,
      phase: "embedding",
      processed: 3,
    });
    render(<AiProgressBar />);

    fireEvent.click(await screen.findByRole("button", { name: label }));
    await waitFor(() =>
      expect(ipc.client.photos[action]).toHaveBeenCalledExactlyOnceWith({})
    );
    expect(ipc.client.photos.resetAiIndex).not.toHaveBeenCalled();
    expect(ipc.client.photos.startAiIndexing).not.toHaveBeenCalled();
  });
});
