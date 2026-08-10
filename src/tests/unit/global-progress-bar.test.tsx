import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GlobalProgressBar } from "@/components/global-progress-bar";
import type { GlobalAiProgress } from "@/hooks/use-global-ai-status";
import { useGlobalAiStatus } from "@/hooks/use-global-ai-status";

vi.mock("@/hooks/use-global-ai-status", () => ({
  useGlobalAiStatus: vi.fn(),
}));

vi.mock("@/hooks/use-reduced-motion", () => ({
  useReducedMotion: () => false,
}));

vi.mock("@/ipc/manager", () => ({
  ipc: {
    client: {
      photos: {
        stopScanning: vi.fn(),
      },
    },
  },
}));

vi.mock("@/utils/progress-phrases", () => ({
  getRandomPhrase: () => "测试进度",
}));

const mockedUseGlobalAiStatus = vi.mocked(useGlobalAiStatus);

function getProgressBar(container: HTMLElement): HTMLElement {
  const bar = container.querySelector<HTMLElement>(
    '[data-reduced-motion-keep="progress-bar"]'
  );
  if (!bar) {
    throw new Error("Global progress bar is not rendered");
  }
  return bar;
}

describe("GlobalProgressBar", () => {
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("shows again when a new task starts during the exit animation", () => {
    let status: GlobalAiProgress = {
      canCancel: false,
      isRunning: true,
      percent: 42,
      phase: "embedding",
      statusText: "第一批",
    };
    mockedUseGlobalAiStatus.mockImplementation(() => status);

    const view = render(<GlobalProgressBar />);
    expect(getProgressBar(view.container)).toHaveClass("opacity-100");

    status = {
      ...status,
      isRunning: false,
      phase: "idle",
      statusText: "",
    };
    view.rerender(<GlobalProgressBar />);
    expect(getProgressBar(view.container)).toHaveClass("opacity-0");

    status = {
      ...status,
      isRunning: true,
      phase: "import-queue",
      statusText: "第二批",
    };
    act(() => {
      view.rerender(<GlobalProgressBar />);
    });

    expect(getProgressBar(view.container)).toHaveClass("opacity-100");
  });
});
