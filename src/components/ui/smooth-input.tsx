import {
  type ComponentPropsWithRef,
  type ReactNode,
  type RefObject,
  useCallback,
  useLayoutEffect,
  useRef,
} from "react";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { cn } from "@/utils/tailwind";
import "./smooth-input.css";

const BIDIRECTIONAL_TEXT =
  /[\u0590-\u08ff\u200e-\u200f\u202a-\u202e\u2066-\u2069\ufb1d-\ufdff\ufe70-\ufeff]/u;
const INPUT_TYPES = new Set(["text", "search", "url", "tel"]);
const ANIMATED_INPUT_TYPES = new Set([
  "insertText",
  "deleteContentBackward",
  "deleteContentForward",
]);

export interface SmoothCaretProps {
  children: ReactNode;
  className?: string;
  inputRef: RefObject<HTMLInputElement | null>;
  value?: ComponentPropsWithRef<"input">["value"];
}

interface CaretGeometry {
  height: number;
  left: number;
  top: number;
  width: number;
  x: number;
  y: number;
}

function measureCaret(
  input: HTMLInputElement,
  measure: HTMLSpanElement
): CaretGeometry | null {
  const styles = getComputedStyle(input);
  if (
    !INPUT_TYPES.has(input.type) ||
    input.disabled ||
    input.readOnly ||
    styles.direction === "rtl" ||
    input.dir === "rtl" ||
    BIDIRECTIONAL_TEXT.test(input.value) ||
    input.selectionStart === null ||
    input.clientWidth <= 0
  ) {
    return null;
  }

  measure.style.font = styles.font;
  measure.style.letterSpacing = styles.letterSpacing;
  measure.style.fontFeatureSettings = styles.fontFeatureSettings;
  measure.style.fontVariationSettings = styles.fontVariationSettings;
  measure.style.fontKerning = styles.fontKerning;
  measure.style.textTransform = styles.textTransform;
  measure.style.tabSize = styles.tabSize;
  measure.textContent = input.value;
  let prefixWidth = 0;
  if (input.selectionStart > 0 && measure.firstChild) {
    const range = document.createRange();
    range.setStart(measure.firstChild, 0);
    range.setEnd(measure.firstChild, input.selectionStart);
    prefixWidth = range.getBoundingClientRect().width;
    // A hidden/unmeasurable font must never leave the user without a caret.
    if (!(prefixWidth > 0)) {
      return null;
    }
  }
  const paddingLeft = Number.parseFloat(styles.paddingLeft) || 0;
  const paddingRight = Number.parseFloat(styles.paddingRight) || 0;
  const paddingTop = Number.parseFloat(styles.paddingTop) || 0;
  const paddingBottom = Number.parseFloat(styles.paddingBottom) || 0;
  const height = Number.parseFloat(styles.fontSize) * 0.9;
  const x = paddingLeft + prefixWidth - input.scrollLeft;
  if (
    !Number.isFinite(height) ||
    !Number.isFinite(x) ||
    x < paddingLeft - 1 ||
    x > input.clientWidth - paddingRight + 1
  ) {
    return null;
  }
  return {
    height,
    left: input.offsetLeft + input.clientLeft,
    top: input.offsetTop + input.clientTop,
    width: input.clientWidth,
    x: Math.min(x, input.clientWidth - paddingRight - 1.5),
    y:
      paddingTop +
      (input.clientHeight - paddingTop - paddingBottom - height) / 2,
  };
}

/** Decorates the existing input without replacing its value or event handlers. */
export function SmoothCaret({
  children,
  className,
  inputRef,
  value: _value,
}: SmoothCaretProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLSpanElement>(null);
  const caretRef = useRef<HTMLSpanElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  const updateRef = useRef<(() => void) | null>(null);
  const composingRef = useRef(false);
  const appReduceMotion = useReducedMotion();
  const systemReduceMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const forcedColors = useMediaQuery("(forced-colors: active)");
  const nativeOnly = appReduceMotion || systemReduceMotion || forcedColors;

  useLayoutEffect(() => {
    const input = inputRef.current;
    const viewport = viewportRef.current;
    const caret = caretRef.current;
    const measure = measureRef.current;
    const container = containerRef.current;
    if (!(input && viewport && caret && measure && container)) {
      return;
    }

    let frame: number | null = null;
    let animate = false;
    let active = true;
    let lastInputValue = input.value;
    let lastCaretX: number | null = null;
    let detachFocusedListeners: (() => void) | null = null;

    const hide = () => {
      delete input.dataset.smoothCaretActive;
      viewport.hidden = true;
    };
    const cancelFrame = () => {
      if (frame !== null) {
        cancelAnimationFrame(frame);
        frame = null;
      }
    };
    const update = () => {
      frame = null;
      if (
        nativeOnly ||
        composingRef.current ||
        document.activeElement !== input
      ) {
        hide();
        return;
      }
      if (input.selectionStart !== input.selectionEnd) {
        hide();
        return;
      }
      let geometry: CaretGeometry | null;
      try {
        geometry = measureCaret(input, measure);
      } catch {
        geometry = null;
      }
      if (!geometry) {
        hide();
        return;
      }
      const wasVisible = !viewport.hidden;
      viewport.style.left = `${geometry.left}px`;
      viewport.style.top = `${geometry.top}px`;
      viewport.style.width = `${geometry.width}px`;
      viewport.style.height = `${input.clientHeight}px`;
      caret.style.height = `${geometry.height}px`;
      caret.style.top = `${geometry.y}px`;
      const transform = `translateX(${geometry.x}px)`;
      if (
        !wasVisible ||
        lastCaretX === null ||
        Math.abs(lastCaretX - geometry.x) > 0.01
      ) {
        caret.style.transitionDuration =
          animate && wasVisible ? "100ms" : "0ms";
        caret.style.transform = transform;
        lastCaretX = geometry.x;
      }
      viewport.hidden = false;
      input.dataset.smoothCaretActive = "true";
      animate = false;
      for (const animation of caret.getAnimations?.() ?? []) {
        if (
          "animationName" in animation &&
          animation.animationName === "smooth-input-blink"
        ) {
          animation.currentTime = 0;
        }
      }
    };
    const schedule = () => {
      if (frame === null && document.activeElement === input) {
        frame = requestAnimationFrame(update);
      }
    };
    const snap = () => {
      animate = false;
      caret.style.transitionDuration = "0ms";
      schedule();
    };
    const handleInput = (event: Event) => {
      lastInputValue = input.value;
      animate = ANIMATED_INPUT_TYPES.has((event as InputEvent).inputType);
      if (!animate) {
        caret.style.transitionDuration = "0ms";
      }
      schedule();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      animate = ["ArrowLeft", "ArrowRight", "Backspace", "Delete"].includes(
        event.key
      );
      schedule();
    };
    const handleCompositionStart = () => {
      composingRef.current = true;
      cancelFrame();
      hide();
    };
    const handleCompositionEnd = () => {
      composingRef.current = false;
      snap();
    };
    const handleFocus = () => {
      if (detachFocusedListeners || nativeOnly) {
        return;
      }
      let observedWidth = input.clientWidth;
      let observedHeight = input.clientHeight;
      const handleResize = () => {
        // Chromium may report an input's internal content box after typing.
        // Re-measure actual viewport changes without interrupting text motion.
        if (
          input.clientWidth !== observedWidth ||
          input.clientHeight !== observedHeight
        ) {
          observedWidth = input.clientWidth;
          observedHeight = input.clientHeight;
          schedule();
        }
      };
      const observer =
        typeof ResizeObserver === "undefined"
          ? null
          : new ResizeObserver(handleResize);
      observer?.observe(input);
      observer?.observe(container);
      document.addEventListener("selectionchange", schedule);
      document.fonts?.addEventListener("loadingdone", snap);
      void document.fonts?.ready.then(() => {
        if (active) {
          snap();
        }
      });
      input.addEventListener("input", handleInput);
      input.addEventListener("keydown", handleKeyDown);
      input.addEventListener("pointerdown", snap);
      input.addEventListener("pointerup", snap);
      input.addEventListener("paste", snap);
      input.addEventListener("select", schedule);
      input.addEventListener("scroll", snap);
      detachFocusedListeners = () => {
        observer?.disconnect();
        document.removeEventListener("selectionchange", schedule);
        document.fonts?.removeEventListener("loadingdone", snap);
        input.removeEventListener("input", handleInput);
        input.removeEventListener("keydown", handleKeyDown);
        input.removeEventListener("pointerdown", snap);
        input.removeEventListener("pointerup", snap);
        input.removeEventListener("paste", snap);
        input.removeEventListener("select", schedule);
        input.removeEventListener("scroll", snap);
        detachFocusedListeners = null;
      };
      snap();
    };
    const handleBlur = () => {
      detachFocusedListeners?.();
      composingRef.current = false;
      cancelFrame();
      hide();
    };
    updateRef.current = () => {
      if (input.value !== lastInputValue) {
        animate = false;
        caret.style.transitionDuration = "0ms";
        lastInputValue = input.value;
      }
      schedule();
    };
    input.addEventListener("focus", handleFocus);
    input.addEventListener("blur", handleBlur);
    // Composition protection is also needed when using the native caret.
    input.addEventListener("compositionstart", handleCompositionStart);
    input.addEventListener("compositionend", handleCompositionEnd);
    input.addEventListener("keydown", handleCompositionEnter);
    function handleCompositionEnter(event: KeyboardEvent) {
      if (
        (composingRef.current || event.isComposing || event.keyCode === 229) &&
        event.key === "Enter"
      ) {
        event.stopPropagation();
      }
    }
    if (document.activeElement === input) {
      handleFocus();
    }
    return () => {
      active = false;
      detachFocusedListeners?.();
      cancelFrame();
      hide();
      updateRef.current = null;
      input.removeEventListener("focus", handleFocus);
      input.removeEventListener("blur", handleBlur);
      input.removeEventListener("compositionstart", handleCompositionStart);
      input.removeEventListener("compositionend", handleCompositionEnd);
      input.removeEventListener("keydown", handleCompositionEnter);
    };
  }, [inputRef, nativeOnly]);

  // Also covers controlled assignments that do not fire a native input event.
  useLayoutEffect(() => {
    updateRef.current?.();
  });

  return (
    <div
      className={cn("smooth-input relative min-w-0", className)}
      ref={containerRef}
    >
      {children}
      <span aria-hidden="true" className="smooth-input__measure-clip">
        <span className="smooth-input__measure" ref={measureRef} />
      </span>
      <span
        aria-hidden="true"
        className="smooth-input__viewport"
        hidden
        ref={viewportRef}
      >
        <span className="smooth-input__caret" ref={caretRef} />
      </span>
    </div>
  );
}

export interface SmoothInputProps extends ComponentPropsWithRef<"input"> {
  wrapperClassName?: string;
}

export function SmoothInput({
  className,
  ref,
  value,
  wrapperClassName,
  ...props
}: SmoothInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const setInputRef = useCallback(
    (node: HTMLInputElement | null) => {
      inputRef.current = node;
      if (typeof ref === "function") {
        const cleanup = ref(node);
        if (typeof cleanup === "function") {
          return () => {
            inputRef.current = null;
            cleanup();
          };
        }
        return;
      }
      if (ref) {
        ref.current = node;
      }
    },
    [ref]
  );
  return (
    <SmoothCaret
      className={cn("w-full", wrapperClassName)}
      inputRef={inputRef}
      value={value}
    >
      <input
        {...props}
        className={cn("block w-full min-w-0", className)}
        ref={setInputRef}
        value={value}
      />
    </SmoothCaret>
  );
}
