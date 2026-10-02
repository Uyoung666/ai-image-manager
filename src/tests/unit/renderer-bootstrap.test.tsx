import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRendererBootstrap } from "@/utils/renderer-bootstrap";

vi.mock("react-dom/client", () => ({
  createRoot: vi.fn(() => ({ render: vi.fn() })),
}));

afterEach(() => vi.clearAllMocks());

describe("renderer bootstrap lifecycle", () => {
  it("reuses the root across module generations", async () => {
    const container = document.createElement("div");
    let bootstrap = createRendererBootstrap(container);
    for (let round = 0; round < 5; round++) {
      bootstrap.dispose();
      bootstrap = createRendererBootstrap(container, bootstrap.root);
      await bootstrap.renderAfterInitialization(async () => undefined, "app");
    }
    expect(createRoot).toHaveBeenCalledExactlyOnceWith(container);
    expect(bootstrap.root.render).toHaveBeenCalledTimes(5);
  });

  it("prevents stale initialization from overwriting the latest generation", async () => {
    let resolveOld: (() => void) | undefined;
    const oldInitialization = new Promise<void>((resolve) => {
      resolveOld = resolve;
    });
    const container = document.createElement("div");
    const oldBootstrap = createRendererBootstrap(container);
    const oldRender = oldBootstrap.renderAfterInitialization(
      () => oldInitialization,
      "old"
    );
    oldBootstrap.dispose();
    const current = createRendererBootstrap(container, oldBootstrap.root);
    await current.renderAfterInitialization(async () => undefined, "current");
    resolveOld?.();
    await oldRender;
    expect(current.root.render).toHaveBeenCalledExactlyOnceWith("current");
  });

  it("renders the fallback language when initialization rejects", async () => {
    const bootstrap = createRendererBootstrap(document.createElement("div"));
    await bootstrap.renderAfterInitialization(
      () => Promise.reject(new Error("locale unavailable")),
      "fallback"
    );
    expect(bootstrap.root.render).toHaveBeenCalledExactlyOnceWith("fallback");
  });

  it("does not render a disposed generation after initialization fails", async () => {
    const bootstrap = createRendererBootstrap(document.createElement("div"));
    await act(async () => {
      const pending = bootstrap.renderAfterInitialization(
        () => Promise.reject(new Error("locale unavailable")),
        "old"
      );
      bootstrap.dispose();
      await pending;
    });
    expect(bootstrap.root.render).not.toHaveBeenCalled();
  });
});
