import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { readExportPreferences } from "@/actions/export-preferences";
import { ExportDialog } from "@/components/ExportDialog";

const actions = vi.hoisted(() => ({
  choosePath: vi.fn(),
  export: vi.fn(),
  openFolder: vi.fn(),
}));
const toast = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock("@/actions/photo-export", () => ({ photoExportActions: actions }));
vi.mock("sonner", () => ({ toast }));
beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  actions.choosePath.mockResolvedValue({ path: "C:/fixture/export.zip" });
  actions.export.mockResolvedValue({
    success: true,
    path: "C:/fixture/export.zip",
    filename: "export.zip",
    photoCount: 2,
    sizeMB: 1,
  });
  actions.openFolder.mockResolvedValue(undefined);
});
it("remembers successful settings and defaults to leaving the folder closed", async () => {
  const view = render(
    <ExportDialog onClose={vi.fn()} open photoIds={[1, 2]} />
  );
  fireEvent.click(screen.getByRole("button", { name: "exportCompressed" }));
  fireEvent.change(screen.getAllByRole("slider")[0], {
    target: { value: "70" },
  });
  fireEvent.change(screen.getAllByRole("slider")[1], {
    target: { value: "1280" },
  });
  fireEvent.click(screen.getByRole("button", { name: "exportAction" }));
  await waitFor(() => expect(actions.export).toHaveBeenCalled());
  expect(actions.openFolder).not.toHaveBeenCalled();
  expect(readExportPreferences()).toEqual({
    format: "compressed",
    quality: 70,
    maxWidth: 1280,
    openAfterExport: false,
  });
  fireEvent.click(screen.getByRole("button", { name: "打开所在文件夹" }));
  await waitFor(() =>
    expect(actions.openFolder).toHaveBeenCalledWith("C:/fixture/export.zip")
  );
  view.rerender(
    <ExportDialog onClose={vi.fn()} open={false} photoIds={[1, 2]} />
  );
  view.rerender(<ExportDialog onClose={vi.fn()} open photoIds={[1, 2]} />);
  expect(screen.getAllByRole("slider")[0]).toHaveValue("70");
  expect(screen.getAllByRole("slider")[1]).toHaveValue("1280");
});
it("keeps a successful export when opening the folder fails", async () => {
  actions.openFolder.mockRejectedValue(new Error("shell failure"));
  render(<ExportDialog onClose={vi.fn()} open photoIds={[1, 2]} />);
  fireEvent.click(
    screen.getByRole("checkbox", { name: "导出后自动打开文件夹（记住选择）" })
  );
  fireEvent.click(screen.getByRole("button", { name: "exportAction" }));
  await waitFor(() =>
    expect(toast.error).toHaveBeenCalledWith("导出已完成，但无法打开文件夹")
  );
  expect(screen.getByRole("button", { name: "打开所在文件夹" })).toBeVisible();
  expect(readExportPreferences().openAfterExport).toBe(true);
});
it("does not remember failed or cancelled export attempts", async () => {
  actions.export.mockResolvedValue({ success: false, error: "failed" });
  render(<ExportDialog onClose={vi.fn()} open photoIds={[1]} />);
  fireEvent.click(screen.getByRole("button", { name: "exportCompressed" }));
  fireEvent.click(screen.getByRole("button", { name: "exportAction" }));
  await waitFor(() => expect(screen.getByText("failed")).toBeVisible());
  expect(readExportPreferences().format).toBe("original");
  actions.choosePath.mockResolvedValue(null);
  fireEvent.click(screen.getByRole("button", { name: "exportAction" }));
  await waitFor(() => expect(actions.choosePath).toHaveBeenCalledTimes(2));
  expect(actions.export).toHaveBeenCalledTimes(1);
});
it("validates stored numeric settings and recovers from malformed storage", () => {
  localStorage.setItem(
    "photo-export.preferences",
    JSON.stringify({
      format: "compressed",
      quality: -2,
      maxWidth: 900_000,
      openAfterExport: "true",
    })
  );
  expect(readExportPreferences()).toEqual({
    format: "compressed",
    quality: 85,
    maxWidth: 1920,
    openAfterExport: false,
  });
  localStorage.setItem("photo-export.preferences", "bad");
  expect(readExportPreferences().format).toBe("original");
});
