import {
  type MouseEvent,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  createBackToTopController,
  shouldShowBackToTop,
} from "@/utils/back-to-top";

export function useBackToTop(
  scrollRef: RefObject<HTMLElement | null>,
  onStart?: () => void,
  resetKey?: string,
  onPositioned?: () => void
) {
  const [show, setShow] = useState(false);
  const controllerRef = useRef<ReturnType<
    typeof createBackToTopController
  > | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a reused gallery must cancel its previous route's pending jump
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) {
      return;
    }
    const controller = createBackToTopController(element, onPositioned);
    controllerRef.current = controller;
    const update = () => setShow(shouldShowBackToTop(element));
    element.addEventListener("scroll", update, { passive: true });
    const resize = new ResizeObserver(update);
    resize.observe(element);
    update();
    return () => {
      controller.cancel();
      controllerRef.current = null;
      element.removeEventListener("scroll", update);
      resize.disconnect();
    };
  }, [scrollRef, resetKey, onPositioned]);

  const onClick = useCallback(
    (event: MouseEvent) => {
      event.stopPropagation();
      controllerRef.current?.start(event.detail === 0, onStart);
    },
    [onStart]
  );

  return { show, onClick };
}
