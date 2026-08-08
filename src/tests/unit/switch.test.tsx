import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Switch } from "@/components/ui/switch";

describe("Switch", () => {
  it("exposes an accessible checkbox and forwards changes", () => {
    const onCheckedChange = vi.fn();
    render(
      <Switch
        ariaLabel="Enable feature"
        checked={false}
        onCheckedChange={onCheckedChange}
      />
    );

    const input = screen.getByRole("checkbox", { name: "Enable feature" });
    expect(input).not.toBeChecked();

    fireEvent.click(input);

    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });
});
