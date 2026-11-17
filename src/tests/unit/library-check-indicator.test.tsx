import { act, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { LibraryCheckIndicator } from "@/components/library-check-indicator";
import { TooltipProvider } from "@/components/ui/tooltip";

vi.mock("@/ipc/manager", () => ({
  ipc: {
    client: {
      photos: {
        getImportQueueStatus: async () => ({
          current: null,
          pending: [],
          history: [],
        }),
      },
    },
  },
}));
afterEach(() => vi.useRealTimers());
it("debounces active background checks and hides on completion without exposing user imports", async () => {
  vi.useFakeTimers();
  render(
    <TooltipProvider>
      <LibraryCheckIndicator />
    </TooltipProvider>
  );
  await act(async () => {
    await Promise.resolve();
  });
  const send = (source: string | null) =>
    act(() =>
      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            channel: "import-queue-status",
            current: source
              ? { id: 1, source, status: "scanning", folderPath: "C:/photos" }
              : null,
            pending: [],
            history: [],
          },
        })
      )
    );
  send("background");
  act(() => vi.advanceTimersByTime(499));
  expect(screen.queryByTestId("library-check-indicator")).toBeNull();
  act(() => vi.advanceTimersByTime(1));
  expect(screen.getByTestId("library-check-indicator")).toBeInTheDocument();
  send(null);
  act(() => vi.advanceTimersByTime(299));
  expect(screen.getByTestId("library-check-indicator")).toBeInTheDocument();
  act(() => vi.advanceTimersByTime(1));
  expect(screen.queryByTestId("library-check-indicator")).toBeNull();
  send("user");
  act(() => vi.advanceTimersByTime(1000));
  expect(screen.queryByTestId("library-check-indicator")).toBeNull();
});
