import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AiIndexRebuildNotice } from "@/components/AiIndexRebuildNotice";
import { StatusBar } from "@/components/StatusBar";
import type { AiStatus } from "@/types/photo";

const FINGERPRINT_ERROR = /fingerprint-mismatch/;

describe("AI index recovery guidance", () => {
  it("opens recovery settings only after clicking the visible action", () => {
    const onOpenSettings = vi.fn();
    render(<AiIndexRebuildNotice onOpenSettings={onOpenSettings} />);
    expect(
      screen.getByRole("alert", { name: "aiIndexRebuildRequired" })
    ).toBeInTheDocument();
    expect(
      screen.getByText("aiIndexRebuildNoticeDescription")
    ).toBeInTheDocument();
    expect(screen.getByText("aiIndexRebuildFallback")).toBeInTheDocument();
    expect(onOpenSettings).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "aiIndexOpenSettings" })
    );
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });

  it("shows localized recovery rather than an internal fingerprint error or stale ready state", () => {
    const aiStatus: AiStatus = {
      coverageState: "error",
      embeddingProgress: { processed: 0, total: 8, phase: "idle" },
      hasVectors: true,
      indexedPhotos: 8,
      indexReady: true,
      isEmbedding: false,
      lastError: "Vector store incompatible: fingerprint-mismatch",
      model: "ready",
      pendingPhotos: 0,
      rebuildRequired: true,
      totalPhotos: 8,
      vectorCount: 8,
      vectorDB: "error",
    };
    render(<StatusBar aiStatus={aiStatus} selectedCount={0} totalPhotos={8} />);
    expect(screen.getByText("aiIndexRebuildRequired")).toBeInTheDocument();
    expect(screen.queryByText(FINGERPRINT_ERROR)).toBeNull();
  });
});
