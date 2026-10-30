import { act, fireEvent, render, screen } from "@testing-library/react";
import { createRef, type ReactNode, useContext, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FavoriteIcon } from "@/components/icons/favorite-icon";
import {
  IconAnimationContext,
  IconMotionProvider,
  IconMotionTrigger,
} from "@/components/icons/icon-motion";
import { Settings } from "@/components/icons/settings";
import { UiPreferencesContext } from "@/contexts/ui-preferences-context";

const controls = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
  set: vi.fn(),
}));
vi.mock("motion/react", () => ({
  useAnimationControls: () => controls,
  LazyMotion: ({ children }: { children: ReactNode }) => children,
  domAnimation: {},
}));
vi.mock("motion/react-m", () => ({
  g: ({ children }: { children: ReactNode }) => <g>{children}</g>,
  path: ({ d }: { d: string }) => <path d={d} />,
}));

function Probe() {
  const state = useContext(IconAnimationContext);
  return (
    <span data-testid="probe">{`${state.allowed}:${state.engaged}:${state.sequence}`}</span>
  );
}
function Example({
  reduced = false,
  disabled = false,
  busy = false,
  active,
  initial = false,
}: {
  reduced?: boolean;
  disabled?: boolean;
  busy?: boolean;
  active?: boolean;
  initial?: boolean;
}) {
  return (
    <UiPreferencesContext.Provider
      value={{ reduceMotion: reduced, setReduceMotion: vi.fn() }}
    >
      <IconMotionProvider>
        <IconMotionTrigger active={active} busy={busy} disabled={disabled}>
          <button disabled={disabled} type="button">
            <Settings />
            <Probe />
            {initial ? <FavoriteIcon /> : null}
          </button>
        </IconMotionTrigger>
      </IconMotionProvider>
    </UiPreferencesContext.Provider>
  );
}

describe("shared icon motion", () => {
  let systemReduced = false;
  let mediaListeners: Set<() => void>;
  beforeEach(() => {
    vi.clearAllMocks();
    systemReduced = false;
    mediaListeners = new Set();
    vi.stubGlobal("matchMedia", () => ({
      matches: systemReduced,
      addEventListener: (_: string, listener: () => void) =>
        mediaListeners.add(listener),
      removeEventListener: (_: string, listener: () => void) =>
        mediaListeners.delete(listener),
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("starts once for the whole control, coalesces focus and hover, and cancels on exit", () => {
    render(<Example />);
    expect(controls.start).not.toHaveBeenCalled();
    const button = screen.getByRole("button");
    fireEvent.pointerEnter(button, { pointerType: "mouse" });
    expect(controls.start).toHaveBeenCalledWith("animate");
    fireEvent.focus(button);
    expect(controls.start).toHaveBeenCalledTimes(1);
    fireEvent.pointerLeave(button);
    expect(screen.getByTestId("probe")).toHaveTextContent("true:true:1");
    fireEvent.blur(button);
    expect(controls.start).toHaveBeenLastCalledWith("normal", {
      duration: 0.12,
    });
    fireEvent.pointerEnter(button);
    expect(screen.getByTestId("probe")).toHaveTextContent("true:true:2");
  });

  it("preserves the button, child click handler and ref without adding a focus node", () => {
    const ref = createRef<HTMLButtonElement>();
    const click = vi.fn();
    const { container } = render(
      <IconMotionProvider>
        <IconMotionTrigger>
          <button onClick={click} ref={ref} type="button">
            <Settings />
          </button>
        </IconMotionTrigger>
      </IconMotionProvider>
    );
    expect(container.firstElementChild).toBe(ref.current);
    fireEvent.click(screen.getByRole("button"));
    expect(click).toHaveBeenCalledTimes(1);
    expect(container.querySelectorAll("button")).toHaveLength(1);
    expect(container.querySelector("svg")).toHaveAttribute(
      "aria-hidden",
      "true"
    );
  });

  it("suppresses disabled and busy controls and stops an in-flight animation", () => {
    const view = render(<Example />);
    fireEvent.pointerEnter(screen.getByRole("button"));
    view.rerender(<Example busy />);
    expect(screen.getByTestId("probe")).toHaveTextContent("false:false:1");
    controls.start.mockClear();
    fireEvent.pointerEnter(screen.getByRole("button"));
    expect(controls.start).not.toHaveBeenCalled();
    view.rerender(<Example disabled />);
    fireEvent.focus(screen.getByRole("button"));
    expect(controls.start).not.toHaveBeenCalled();
  });

  it("immediately resets for either reduced-motion preference and does not replay on re-enable", () => {
    const view = render(<Example />);
    fireEvent.pointerEnter(screen.getByRole("button"));
    view.rerender(<Example reduced />);
    expect(controls.set).toHaveBeenLastCalledWith("normal");
    expect(screen.getByTestId("probe")).toHaveTextContent("false:false:1");
    controls.start.mockClear();
    view.rerender(<Example />);
    expect(controls.start).not.toHaveBeenCalledWith("animate");
    act(() => {
      systemReduced = true;
      for (const listener of mediaListeners) {
        listener();
      }
    });
    expect(screen.getByTestId("probe")).toHaveTextContent("false:false:1");
  });

  it("pauses when the window blurs and releases subscriptions on unmount", () => {
    const view = render(<Example />);
    fireEvent.pointerEnter(screen.getByRole("button"));
    fireEvent(window, new Event("blur"));
    expect(screen.getByTestId("probe")).toHaveTextContent("false:false:1");
    controls.start.mockClear();
    fireEvent(window, new Event("focus"));
    expect(controls.start).not.toHaveBeenCalledWith("animate");
    view.unmount();
    expect(controls.stop).toHaveBeenCalled();
    expect(mediaListeners.size).toBe(0);
  });

  it("only plays on controlled active transitions, not an initially active control", () => {
    const view = render(<Example active />);
    expect(controls.start).not.toHaveBeenCalledWith("animate");
    view.rerender(<Example active={false} />);
    view.rerender(<Example active />);
    expect(controls.start).toHaveBeenCalledWith("animate");
  });

  it("stops hidden windows and does not animate newly mounted icons during an existing hover", () => {
    function Swapping({ alternate = false }: { alternate?: boolean }) {
      return (
        <IconMotionProvider>
          <IconMotionTrigger>
            <button type="button">
              <Settings key={String(alternate)} />
            </button>
          </IconMotionTrigger>
        </IconMotionProvider>
      );
    }
    const view = render(<Swapping />);
    fireEvent.pointerEnter(screen.getByRole("button"));
    controls.start.mockClear();
    view.rerender(<Swapping alternate />);
    expect(controls.start).not.toHaveBeenCalledWith("animate");
    const descriptor = Object.getOwnPropertyDescriptor(
      document,
      "visibilityState"
    );
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    fireEvent(document, new Event("visibilitychange"));
    expect(document.documentElement).toHaveAttribute(
      "data-icon-motion-paused",
      "true"
    );
    if (descriptor) {
      Object.defineProperty(document, "visibilityState", descriptor);
    } else {
      Reflect.deleteProperty(document, "visibilityState");
    }
  });

  it("keeps icons without a trigger static and animates only the directly clicked favorite", () => {
    const view = render(
      <IconMotionProvider>
        <Settings />
      </IconMotionProvider>
    );
    expect(controls.start).not.toHaveBeenCalled();
    view.unmount();
    render(
      <>
        <Example initial />
        <FavoriteIcon data-testid="other-star" />
      </>
    );
    fireEvent.click(screen.getByRole("button"));
    expect(
      screen.getByRole("button").querySelector("[data-favorite-icon]")
    ).toHaveAttribute("data-favorite-feedback");
    expect(screen.getByTestId("other-star")).not.toHaveAttribute(
      "data-favorite-feedback"
    );
  });

  it("keeps click feedback through a favorite state update and clears it on pause", () => {
    function Toggle() {
      const [favorite, setFavorite] = useState(false);
      return (
        <IconMotionProvider>
          <IconMotionTrigger>
            <button
              onClick={() => setFavorite((value) => !value)}
              type="button"
            >
              <FavoriteIcon className={favorite ? "fill-current" : ""} />
            </button>
          </IconMotionTrigger>
        </IconMotionProvider>
      );
    }
    render(<Toggle />);
    const button = screen.getByRole("button");
    fireEvent.click(button);
    const icon = button.querySelector("svg");
    expect(icon).toHaveClass("fill-current");
    expect(icon).toHaveAttribute("data-favorite-feedback");
    fireEvent(window, new Event("blur"));
    expect(icon).not.toHaveAttribute("data-favorite-feedback");
    fireEvent(window, new Event("focus"));
    expect(icon).not.toHaveAttribute("data-favorite-feedback");
  });
});
