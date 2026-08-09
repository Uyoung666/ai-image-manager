import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "@/components/ErrorBoundary";

const diagnosticsMocks = vi.hoisted(() => ({ record: vi.fn() }));

vi.mock("@/actions/diagnostics", () => ({
  recordRendererIncident: diagnosticsMocks.record,
}));

vi.mock("@/components/diagnostics-report-form", () => ({
  DiagnosticsReportDialog: ({ open }: { open: boolean }) =>
    open ? <div>diagnostics-dialog-open</div> : null,
}));

function BrokenView(): never {
  throw new Error("Renderer exploded");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ErrorBoundary diagnostics", () => {
  it("records the incident and opens the report dialog without navigation", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    diagnosticsMocks.record.mockResolvedValue({
      fingerprint: "123456789abc",
      id: "AIM-20260809-123456-ABCD",
      occurredAt: "2026-08-09T12:34:56.000Z",
    });

    render(
      <ErrorBoundary>
        <BrokenView />
      </ErrorBoundary>
    );

    expect(diagnosticsMocks.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "react-render" })
    );
    fireEvent.click(
      screen.getByRole("button", { name: "diagnosticsFeedbackThisError" })
    );
    expect(await screen.findByText("diagnostics-dialog-open")).toBeVisible();
  });
});
