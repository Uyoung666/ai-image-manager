import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ImportDropLayer } from "@/components/import-drop-layer";

describe("ImportDropLayer", () => {
  it("marks the image zone as allowed for a single image", () => {
    render(
      <ImportDropLayer
        kind="image"
        onDragOver={vi.fn()}
        onDrop={vi.fn()}
        zone="image"
      />
    );

    expect(screen.getByRole("button")).toHaveClass("is-allowed");
  });

  it("marks the folder zone as forbidden for a single image", () => {
    render(
      <ImportDropLayer
        kind="image"
        onDragOver={vi.fn()}
        onDrop={vi.fn()}
        zone="folders"
      />
    );

    expect(screen.getByRole("button")).toHaveClass("is-forbidden");
  });

  it("marks the folder zone as allowed and forwards zone events", () => {
    const onDragOver = vi.fn();
    const onDrop = vi.fn();
    render(
      <ImportDropLayer
        kind="folders"
        onDragOver={onDragOver}
        onDrop={onDrop}
        zone="folders"
      />
    );

    const zone = screen.getByRole("button");
    expect(zone).toHaveClass("is-allowed");

    fireEvent.dragOver(zone, { dataTransfer: {} });
    fireEvent.drop(zone, { dataTransfer: {} });
    expect(onDragOver).toHaveBeenCalledWith(expect.anything(), "folders");
    expect(onDrop).toHaveBeenCalledWith(expect.anything(), "folders");
  });

  it("renders both zones as forbidden for unsupported input", () => {
    render(
      <>
        <ImportDropLayer
          kind="invalid"
          onDragOver={vi.fn()}
          onDrop={vi.fn()}
          zone="image"
        />
        <ImportDropLayer
          kind="invalid"
          onDragOver={vi.fn()}
          onDrop={vi.fn()}
          zone="folders"
        />
      </>
    );

    for (const zone of screen.getAllByRole("button")) {
      expect(zone).toHaveClass("is-forbidden");
    }
  });
});
