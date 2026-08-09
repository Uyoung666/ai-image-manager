import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CullSessionCard } from "@/components/CullSessionCard";

const session = {
  completedAt: null,
  completedComparisons: 0,
  createdAt: 1,
  id: 1,
  mode: "duel",
  name: "植物园 - 对决模式",
  status: "active",
  totalPhotos: 0,
};

describe("CullSessionCard", () => {
  it("keeps action buttons clickable when it is the only card", () => {
    const onClick = vi.fn();
    const onDelete = vi.fn();
    const onDuplicate = vi.fn();
    const onRename = vi.fn();

    render(
      <CullSessionCard
        getModeIcon={() => null}
        getModeLabel={() => "对决模式"}
        onClick={onClick}
        onDelete={onDelete}
        onDuplicate={onDuplicate}
        onRename={onRename}
        session={session}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "rename" }));
    fireEvent.click(screen.getByRole("button", { name: "duplicate" }));
    fireEvent.click(screen.getByRole("button", { name: "delete" }));

    expect(onRename).toHaveBeenCalledTimes(1);
    expect(onDuplicate).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();
  });
});
