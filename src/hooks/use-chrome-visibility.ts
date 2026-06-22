import { useCallback, useEffect, useRef, useState } from "react";

interface UseChromeVisibilityOptions {
  /** When true, toolbar stays visible regardless of mouse activity */
  forceVisible?: boolean;
  /** Auto-hide delay in ms after mouse stops moving (default 2000) */
  hideDelay?: number;
}

/**
 * Auto-hides floating chrome after a period of mouse inactivity.
 * Returns a `visible` flag and event handlers to spread on the container.
 *
 * Usage:
 *   const chrome = useChromeVisibility({ forceVisible: dialogOpen });
 *   <div {...chrome.containerBindings}>
 *     <Toolbar style={{ opacity: chrome.visible ? 1 : 0 }} />
 *   </div>
 */
export function useChromeVisibility(options: UseChromeVisibilityOptions = {}) {
  const { hideDelay = 2000, forceVisible = false } = options;

  const [visible, setVisible] = useState(true);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const visibleRef = useRef(true);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const scheduleHide = useCallback(() => {
    clearTimer();
    timerRef.current = setTimeout(() => {
      if (!forceVisible) {
        visibleRef.current = false;
        setVisible(false);
      }
    }, hideDelay);
  }, [clearTimer, hideDelay, forceVisible]);

  const show = useCallback(() => {
    clearTimer();
    if (!visibleRef.current) {
      visibleRef.current = true;
      setVisible(true);
    }
    scheduleHide();
  }, [clearTimer, scheduleHide]);

  // Start the hide timer on mount
  useEffect(() => {
    scheduleHide();
    return clearTimer;
  }, [scheduleHide, clearTimer]);

  // When forceVisible changes, re-evaluate visibility
  useEffect(() => {
    if (forceVisible) {
      clearTimer();
      if (!visibleRef.current) {
        visibleRef.current = true;
        setVisible(true);
      }
    } else {
      scheduleHide();
    }
  }, [forceVisible, clearTimer, scheduleHide]);

  const containerBindings = {
    onMouseMove: show,
    onMouseEnter: show,
  };

  return { visible: visible || forceVisible, ...containerBindings };
}
