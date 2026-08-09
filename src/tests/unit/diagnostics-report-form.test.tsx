import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiagnosticsReportForm } from "@/components/diagnostics-report-form";

const diagnosticsMocks = vi.hoisted(() => ({
  create: vi.fn(),
  dismiss: vi.fn(),
  overview: vi.fn(),
}));
const shellMocks = vi.hoisted(() => ({
  openExternal: vi.fn(),
  openInExplorer: vi.fn(),
}));

vi.mock("@/actions/diagnostics", () => ({
  createDiagnosticsBundle: diagnosticsMocks.create,
  dismissDiagnosticIncident: diagnosticsMocks.dismiss,
  getDiagnosticsOverview: diagnosticsMocks.overview,
}));

vi.mock("@/actions/shell", () => ({
  openExternalLink: shellMocks.openExternal,
  openInExplorer: shellMocks.openInExplorer,
}));

describe("DiagnosticsReportForm", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    diagnosticsMocks.overview.mockResolvedValue({
      logSizeBytes: 1024,
      nativeDumpAvailable: true,
      pendingIncidents: [
        {
          id: "AIM-20260809-123456-ABCD",
          fingerprint: "123456789abc",
          occurredAt: "2026-08-09T12:34:56.000Z",
          source: "native-crash",
          summary: "Native crash",
          hasNativeDump: true,
        },
      ],
    });
    diagnosticsMocks.dismiss.mockResolvedValue({ dismissed: true });
    diagnosticsMocks.create.mockResolvedValue({
      incidentId: "AIM-20260809-123456-ABCD",
      fingerprint: "123456789abc",
      bundlePath: "D:\\Downloads\\diagnostics.zip",
      issueUrl: "https://github.com/example/issues/new",
      issueBody: "issue body",
      warnings: [],
      includedFiles: ["report.md", "manifest.json", "logs/app.log"],
      nativeDumpIncluded: false,
    });
    shellMocks.openExternal.mockResolvedValue(undefined);
    shellMocks.openInExplorer.mockResolvedValue(undefined);
  });

  it("keeps native dumps off by default and opens the report handoff", async () => {
    render(<DiagnosticsReportForm />);

    const dumpSwitch = await screen.findByRole("checkbox", {
      name: "diagnosticsNativeDump",
    });
    expect(dumpSwitch).not.toBeChecked();

    fireEvent.change(
      screen.getByPlaceholderText("diagnosticsLastActionPlaceholder"),
      { target: { value: "Clicked AI indexing" } }
    );
    fireEvent.click(
      screen.getByRole("button", { name: "diagnosticsGenerateAndReport" })
    );

    await waitFor(() => {
      expect(diagnosticsMocks.create).toHaveBeenCalledWith(
        expect.objectContaining({
          incidentId: "AIM-20260809-123456-ABCD",
          includeNativeDump: false,
          lastAction: "Clicked AI indexing",
        })
      );
    });
    expect(shellMocks.openExternal).toHaveBeenCalledOnce();
    expect(shellMocks.openInExplorer).toHaveBeenCalledWith(
      "D:\\Downloads\\diagnostics.zip"
    );
  });

  it("copies the issue text and exposes retry when GitHub cannot open", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    shellMocks.openExternal.mockRejectedValueOnce(new Error("no browser"));
    render(<DiagnosticsReportForm />);

    await screen.findByRole("checkbox", { name: "diagnosticsNativeDump" });
    fireEvent.change(
      screen.getByPlaceholderText("diagnosticsLastActionPlaceholder"),
      { target: { value: "Opened settings" } }
    );
    fireEvent.click(
      screen.getByRole("button", { name: "diagnosticsGenerateAndReport" })
    );

    expect(
      await screen.findByRole("button", { name: "diagnosticsRetryIssue" })
    ).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith("issue body");
  });
});
