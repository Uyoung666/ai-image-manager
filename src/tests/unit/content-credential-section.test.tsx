import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ContentCredentialSection } from "@/components/ContentCredentialSection";

const { saved, verify } = vi.hoisted(() => ({
  saved: vi.fn(),
  verify: vi.fn(),
}));

vi.mock("@/actions/content-credentials", () => ({
  contentCredentialActions: {
    available: () => Promise.resolve(true),
    saved,
    verify,
  },
}));

const PHOTO = { id: 1, path: "photo.jpg" };
const GENERATOR_NAME = /OpenAI Media Service API/;
const PROVENANCE = {
  generator: "OpenAI Media Service API",
  status: "present_unverified",
} as const;

describe("content credential presentation", () => {
  beforeEach(() => {
    saved.mockReset().mockResolvedValue(null);
    verify.mockReset();
  });

  it("restores the saved result after reopening the photo without a new verification", async () => {
    saved.mockResolvedValue({
      status: "checked",
      signature: "passed",
      binding: "passed",
      trust: "passed",
    });
    const firstView = render(
      <ContentCredentialSection photo={PHOTO} provenance={PROVENANCE} />
    );
    expect(
      await screen.findByText("metadataCredentialSummary_passed")
    ).toBeVisible();
    firstView.unmount();
    render(<ContentCredentialSection photo={PHOTO} provenance={PROVENANCE} />);
    expect(
      await screen.findByText("metadataCredentialSummary_passed")
    ).toBeVisible();
    expect(saved).toHaveBeenCalledTimes(2);
    expect(verify).not.toHaveBeenCalled();
  });

  it("summarizes a successful verification and folds its technical details", async () => {
    verify.mockResolvedValue({
      status: "checked",
      signature: "passed",
      binding: "passed",
      trust: "passed",
    });
    render(<ContentCredentialSection photo={PHOTO} provenance={PROVENANCE} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "metadataCredentialVerify" })
    );

    expect(
      await screen.findByText("metadataCredentialSummary_passed")
    ).toBeVisible();
    expect(screen.getByText(GENERATOR_NAME)).toBeVisible();
    expect(
      screen.queryByText("metadataProvenance_present_unverified")
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "metadataCredentialVerifyAgain" })
    ).toBeEnabled();
    const details = screen.getByRole("button", {
      name: "metadataCredentialDetails",
    });
    expect(details).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByText("metadataCredentialCheck_signature")
    ).not.toBeInTheDocument();
    fireEvent.click(details);
    expect(screen.getAllByText("metadataCredentialCheck_passed")).toHaveLength(
      3
    );
  });

  it("opens details for a mixed result and folds them again after a successful retry", async () => {
    verify
      .mockResolvedValueOnce({
        status: "checked",
        signature: "passed",
        binding: "passed",
        trust: "failed",
      })
      .mockResolvedValueOnce({
        status: "checked",
        signature: "passed",
        binding: "passed",
        trust: "passed",
      });
    render(<ContentCredentialSection photo={PHOTO} provenance={PROVENANCE} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "metadataCredentialVerify" })
    );

    expect(
      await screen.findByText("metadataCredentialSummary_untrusted")
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "metadataCredentialDetails" })
    ).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("metadataCredentialCheck_failed")).toBeVisible();

    fireEvent.click(
      screen.getByRole("button", { name: "metadataCredentialVerifyAgain" })
    );
    expect(
      await screen.findByText("metadataCredentialSummary_passed")
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "metadataCredentialDetails" })
    ).toHaveAttribute("aria-expanded", "false");
  });
});
