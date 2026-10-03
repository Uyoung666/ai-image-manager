import { act, fireEvent, render } from "@testing-library/react";
import { createRef, useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SmoothCaret, SmoothInput } from "@/components/ui/smooth-input";

const preferences = vi.hoisted(() => ({
  app: false,
  system: false,
  colors: false,
}));
vi.mock("@/hooks/use-reduced-motion", () => ({
  useReducedMotion: () => preferences.app,
}));
vi.mock("@/hooks/use-media-query", () => ({
  useMediaQuery: (query: string) =>
    query.includes("forced-colors") ? preferences.colors : preferences.system,
}));

let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
let disconnect: ReturnType<typeof vi.fn<() => void>>;
let resizeCallbacks: (() => void)[];

function flushFrames() {
  act(() => {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) {
      callback(0);
    }
  });
}

function prepareInput() {
  const input = document.querySelector("input") as HTMLInputElement;
  Object.defineProperties(input, {
    clientWidth: { configurable: true, value: 160 },
    clientHeight: { configurable: true, value: 32 },
    clientLeft: { configurable: true, value: 1 },
    clientTop: { configurable: true, value: 1 },
    offsetLeft: { configurable: true, value: 0 },
    offsetTop: { configurable: true, value: 0 },
  });
  input.style.font = "14px sans-serif";
  input.style.padding = "4px 8px";
  act(() => input.focus());
  flushFrames();
  return input;
}

function ControlledInput() {
  const [value, setValue] = useState("hello");
  return (
    <SmoothInput
      aria-label="search"
      onChange={(event) => setValue(event.target.value)}
      value={value}
    />
  );
}

beforeEach(() => {
  Object.assign(preferences, { app: false, system: false, colors: false });
  frames = new Map();
  nextFrame = 0;
  disconnect = vi.fn();
  resizeCallbacks = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal(
    "ResizeObserver",
    class implements ResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(() => callback([], this));
      }
      observe() {
        /* Layout is supplied by prepareInput. */
      }
      unobserve() {
        /* Observations are released together. */
      }
      disconnect = disconnect;
    }
  );
  const createRange = document.createRange.bind(document);
  vi.spyOn(document, "createRange").mockImplementation(() => {
    const range = createRange();
    range.getBoundingClientRect = () =>
      ({ width: range.toString().length * 7.123_456 }) as DOMRect;
    return range;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("SmoothInput", () => {
  it("keeps controlled text immediate and animates ordinary typing only", () => {
    render(<ControlledInput />);
    const input = prepareInput();
    const caret = document.querySelector<HTMLElement>(".smooth-input__caret");
    expect(input.dataset.smoothCaretActive).toBe("true");
    expect(caret?.style.transitionDuration).toBe("0ms");
    fireEvent.input(input, {
      inputType: "insertText",
      target: { value: "hello中" },
    });
    expect(input).toHaveValue("hello中");
    flushFrames();
    expect(caret?.style.transitionDuration).toBe("100ms");
    fireEvent(document, new Event("selectionchange"));
    flushFrames();
    expect(caret?.style.transitionDuration).toBe("100ms");
    fireEvent.input(input, {
      inputType: "insertFromPaste",
      target: { value: "pasted" },
    });
    flushFrames();
    expect(caret?.style.transitionDuration).toBe("0ms");
  });

  it("supports uncontrolled values and forwards the actual DOM ref and handlers", () => {
    const ref = createRef<HTMLInputElement>();
    const onChange = vi.fn();
    const onFocus = vi.fn();
    const onBlur = vi.fn();
    const onKeyDown = vi.fn();
    render(
      <SmoothInput
        aria-label="name"
        defaultValue="start"
        onBlur={onBlur}
        onChange={onChange}
        onFocus={onFocus}
        onKeyDown={onKeyDown}
        ref={ref}
      />
    );
    const input = prepareInput();
    expect(ref.current).toBe(input);
    fireEvent.input(input, {
      inputType: "insertText",
      target: { value: "new" },
    });
    expect(input).toHaveValue("new");
    expect(onChange).toHaveBeenCalledOnce();
    fireEvent.keyDown(input, { key: "ArrowLeft" });
    expect(onKeyDown).toHaveBeenCalledOnce();
    act(() => input.blur());
    expect(onFocus).toHaveBeenCalledOnce();
    expect(onBlur).toHaveBeenCalledOnce();
    expect(input).not.toHaveAttribute("data-smooth-caret-active");
    expect(frames.size).toBe(0);
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("ignores internal resize notifications and updates the viewport without interrupting typing", () => {
    render(<ControlledInput />);
    const input = prepareInput();
    fireEvent.input(input, {
      inputType: "insertText",
      target: { value: "hello!" },
    });
    flushFrames();
    const caret = document.querySelector<HTMLElement>(".smooth-input__caret");
    expect(caret?.style.transitionDuration).toBe("100ms");
    act(() => resizeCallbacks[0]());
    flushFrames();
    expect(caret?.style.transitionDuration).toBe("100ms");
    Object.defineProperty(input, "clientWidth", {
      configurable: true,
      value: 120,
    });
    act(() => resizeCallbacks[0]());
    flushFrames();
    expect(caret?.style.transitionDuration).toBe("100ms");
    expect(
      document.querySelector<HTMLElement>(".smooth-input__viewport")?.style
        .width
    ).toBe("120px");
    expect(input.dataset.smoothCaretActive).toBe("true");
  });

  it("hides the custom caret during a selection and restores it when collapsed", () => {
    render(<SmoothInput defaultValue="hello" />);
    const input = prepareInput();
    act(() => input.setSelectionRange(0, 5, "backward"));
    fireEvent.select(input);
    flushFrames();
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(5);
    expect(input).not.toHaveAttribute("data-smooth-caret-active");
    act(() => input.setSelectionRange(2, 2));
    fireEvent.select(input);
    flushFrames();
    expect(input.dataset.smoothCaretActive).toBe("true");
  });

  it("uses the native caret during composition and does not submit its Enter", () => {
    const submit = vi.fn();
    const start = vi.fn();
    const end = vi.fn();
    render(
      <SmoothInput
        defaultValue="中文"
        onCompositionEnd={end}
        onCompositionStart={start}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            submit();
          }
        }}
      />
    );
    const input = prepareInput();
    fireEvent.compositionStart(input);
    expect(input).not.toHaveAttribute("data-smooth-caret-active");
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(submit).not.toHaveBeenCalled();
    fireEvent.compositionEnd(input);
    flushFrames();
    expect(start).toHaveBeenCalledOnce();
    expect(end).toHaveBeenCalledOnce();
    expect(input.dataset.smoothCaretActive).toBe("true");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(submit).toHaveBeenCalledOnce();
  });

  it.each([
    "app",
    "system",
    "colors",
  ] as const)("falls back immediately when %s disables animation", (preference) => {
    const submit = vi.fn();
    const view = render(
      <SmoothInput defaultValue="hello" onKeyDown={submit} />
    );
    const input = prepareInput();
    expect(input.dataset.smoothCaretActive).toBe("true");
    preferences[preference] = true;
    view.rerender(<SmoothInput defaultValue="hello" onKeyDown={submit} />);
    expect(input).not.toHaveAttribute("data-smooth-caret-active");
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(submit).not.toHaveBeenCalled();
    preferences[preference] = false;
    view.rerender(<SmoothInput defaultValue="hello" onKeyDown={submit} />);
    flushFrames();
    expect(input).not.toHaveAttribute("data-smooth-caret-active");
    fireEvent.compositionEnd(input);
    flushFrames();
    expect(input.dataset.smoothCaretActive).toBe("true");
  });

  it("snaps controlled assignments and accounts for horizontal scrolling", () => {
    const view = render(<SmoothInput onChange={vi.fn()} value="hello" />);
    const input = prepareInput();
    view.rerender(<SmoothInput onChange={vi.fn()} value="updated" />);
    act(() => input.setSelectionRange(7, 7));
    input.scrollLeft = 14;
    fireEvent.scroll(input);
    flushFrames();
    const caret = document.querySelector<HTMLElement>(".smooth-input__caret");
    expect(
      Number.parseFloat(caret?.style.transform.replace("translateX(", "") ?? "")
    ).toBeCloseTo(43.864_192, 3);
    expect(caret?.style.transitionDuration).toBe("0ms");
    expect(input.scrollLeft).toBe(14);
  });

  it.each([
    { value: "שלום" },
    { value: "hello", dir: "rtl" },
    { value: "hello", readOnly: true },
    { value: "hello", disabled: true },
    { value: "hello", type: "password" },
    { value: "123", type: "number" },
  ])("keeps native editing for unsupported input %j", (props) => {
    render(<SmoothInput {...props} onChange={vi.fn()} />);
    const input = prepareInput();
    expect(input).not.toHaveAttribute("data-smooth-caret-active");
  });

  it("restores the native caret on a failed measurement and can recover", () => {
    render(<SmoothInput defaultValue="hello" />);
    const input = prepareInput();
    Object.defineProperty(input, "clientWidth", {
      configurable: true,
      value: 0,
    });
    fireEvent.scroll(input);
    flushFrames();
    expect(input).not.toHaveAttribute("data-smooth-caret-active");
    Object.defineProperty(input, "clientWidth", {
      configurable: true,
      value: 160,
    });
    fireEvent.scroll(input);
    flushFrames();
    expect(input.dataset.smoothCaretActive).toBe("true");
  });

  it("handles autofocus and releases scheduled updates, observers and callback refs", () => {
    const cleanup = vi.fn();
    const ref = vi.fn(() => cleanup);
    const view = render(
      <SmoothInput autoFocus defaultValue="hello" ref={ref} />
    );
    const input = prepareInput();
    expect(document.activeElement).toBe(input);
    fireEvent.keyDown(input, { key: "ArrowLeft" });
    view.unmount();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(frames.size).toBe(0);
    fireEvent(document, new Event("selectionchange"));
    expect(frames.size).toBe(0);
  });

  it("decorates an existing component without changing its input events", () => {
    const change = vi.fn();
    function ExistingInput() {
      const inputRef = useRef<HTMLInputElement>(null);
      return (
        <SmoothCaret inputRef={inputRef}>
          <input
            aria-label="existing"
            defaultValue="hello"
            onChange={change}
            ref={inputRef}
          />
        </SmoothCaret>
      );
    }
    render(<ExistingInput />);
    const input = prepareInput();
    fireEvent.input(input, { target: { value: "updated" } });
    expect(change).toHaveBeenCalledOnce();
    expect(input).toHaveValue("updated");
  });
});
