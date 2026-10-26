type SizeListener = (width: number, height: number) => void;
const sizes = new Map<Element, SizeListener>();
const pendingSizes = new Map<Element, { width: number; height: number }>();
let resize: ResizeObserver | undefined;
let frame = 0;
const roots = new Map<
  Element | null,
  {
    observer: IntersectionObserver;
    listeners: Map<Element, (visible: boolean) => void>;
  }
>();
const dpiListeners = new Set<() => void>();
let media: MediaQueryList | undefined;

export const getGalleryDpr = () => window.devicePixelRatio || 1;
function dpiChanged(): void {
  media?.removeEventListener("change", dpiChanged);
  media = matchMedia(`(resolution: ${getGalleryDpr()}dppx)`);
  media.addEventListener("change", dpiChanged);
  for (const listener of dpiListeners) {
    listener();
  }
}
export function subscribeGalleryDpr(listener: () => void): () => void {
  dpiListeners.add(listener);
  if (!media) {
    media = matchMedia(`(resolution: ${getGalleryDpr()}dppx)`);
    media.addEventListener("change", dpiChanged);
  }
  return () => {
    dpiListeners.delete(listener);
    if (dpiListeners.size === 0) {
      media?.removeEventListener("change", dpiChanged);
      media = undefined;
    }
  };
}

/** Masonry supplies geometry/visibility. Only standalone cards need observers. */
export function observeGalleryImage(
  element: HTMLElement,
  onSize?: SizeListener,
  onVisible?: (visible: boolean) => void
): () => void {
  const root = element.closest(
    "[data-sequence-virtual-scroll], [data-masonry-scroll]"
  );
  if (onSize) {
    resize ??= new ResizeObserver((entries) => {
      for (const entry of entries) {
        pendingSizes.set(entry.target, entry.contentRect);
      }
      if (!frame) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          for (const [target, size] of pendingSizes) {
            sizes.get(target)?.(size.width, size.height);
          }
          pendingSizes.clear();
        });
      }
    });
    sizes.set(element, onSize);
    resize.observe(element);
  }
  if (onVisible) {
    let group = roots.get(root);
    if (!group) {
      const listeners = new Map<Element, (visible: boolean) => void>();
      const observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            listeners.get(entry.target)?.(entry.isIntersecting);
          }
        },
        { root }
      );
      group = { observer, listeners };
      roots.set(root, group);
    }
    group.listeners.set(element, onVisible);
    group.observer.observe(element);
  }
  const bounds = element.getBoundingClientRect();
  onSize?.(bounds.width, bounds.height);
  if (onVisible) {
    const viewport = root?.getBoundingClientRect();
    onVisible(
      bounds.bottom > (viewport?.top ?? 0) &&
        bounds.top < (viewport?.bottom ?? innerHeight) &&
        bounds.right > (viewport?.left ?? 0) &&
        bounds.left < (viewport?.right ?? innerWidth)
    );
  }
  return () => {
    if (onSize) {
      resize?.unobserve?.(element);
      sizes.delete(element);
      pendingSizes.delete(element);
      if (sizes.size === 0) {
        resize?.disconnect();
        resize = undefined;
        cancelAnimationFrame(frame);
        frame = 0;
      }
    }
    const group = roots.get(root);
    if (onVisible && group) {
      group.observer.unobserve?.(element);
      group.listeners.delete(element);
      if (group.listeners.size === 0) {
        group.observer.disconnect();
        roots.delete(root);
      }
    }
  };
}
