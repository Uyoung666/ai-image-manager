import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { libraryReliabilityActions } from "@/actions/library-reliability";
import { LibraryTaskPanel } from "@/components/LibraryTaskPanel";

const getTask = vi.hoisted(() => vi.fn());
vi.mock("@/actions/library-reliability", () => ({
  libraryReliabilityActions: { getTask },
}));
afterEach(cleanup);

it("fetches the next error page and preserves a return to the first page", async () => {
  const first: Awaited<ReturnType<typeof libraryReliabilityActions.getTask>> = {
    taskId: "task",
    status: "done",
    kind: "check",
    phase: "checking",
    scope: {},
    cancellable: false,
    total: 103,
    processed: 103,
    errors: ["EACCES"],
    errorDetails: [{ code: "EACCES", photoId: 2, path: "D:/first.jpg" }],
    errorCount: 101,
    errorOffset: 0,
    errorLimit: 100,
    storedErrorCount: 101,
    hasMoreErrors: true,
    preview: undefined,
    updated: undefined,
    photoStatus: null,
  };
  getTask.mockResolvedValue({
    ...first,
    errorOffset: 100,
    errorDetails: [{ code: "EACCES", photoId: 102, path: "D:/last.jpg" }],
    hasMoreErrors: false,
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <LibraryTaskPanel onCancel={vi.fn()} task={first} />
    </QueryClientProvider>
  );
  fireEvent.click(screen.getByText("libraryReliability.errorCount"));
  expect(screen.getByText("D:/first.jpg")).toBeVisible();
  fireEvent.click(
    screen.getByRole("button", { name: "libraryReliability.nextPage" })
  );
  await screen.findByText("D:/last.jpg");
  expect(getTask).toHaveBeenCalledWith("task", 100);
  expect(
    screen.getByRole("button", { name: "libraryReliability.nextPage" })
  ).toBeDisabled();
  fireEvent.click(
    screen.getByRole("button", { name: "libraryReliability.previousPage" })
  );
  expect(screen.getByText("D:/first.jpg")).toBeVisible();
  client.clear();
});
