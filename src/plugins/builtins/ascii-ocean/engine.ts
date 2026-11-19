import { AsciiRenderer } from "./renderer";
import { type SharkKind, type SharkSpec, World } from "./world";

const STEP = 1 / 60;
const FRAME_MS = 1000 / 30;
const MIXED: SharkKind[] = ["classic", "hammerhead", "thresher", "tiger"];
const KINDS: SharkKind[] = [...MIXED, "zebra", "greathammer", "mako", "nurse"];
const BACKGROUND_AREA =
  'main:is([data-surface="content"], [data-surface="gallery"])';
const BACKGROUND_LAYOUT = "article, div, footer, header, main, ol, section, ul";
const FOREGROUND_AREA = [
  "a[href]",
  "button",
  "details",
  "form",
  "input",
  "label",
  "select",
  "textarea",
  "[contenteditable]",
  "[data-overlay-kind]",
  "[data-photo-id]",
  "[data-sequence-id]",
  '[draggable="true"]',
  "[inert]",
  "nav",
  '[data-surface="card"]',
  '[data-surface="panel"]',
  '[data-surface="section-card"]',
  '[data-surface="inspector"]',
  '[data-surface="media-well"]',
  '[data-surface^="immersive"]',
  '[data-surface="overlay"]',
  '[data-surface="toolbar"]',
  '[tabindex]:not([tabindex="-1"])',
  ".page-toolbar",
].join(", ");

export interface OceanOptions {
  dark: boolean;
  fishCount: number;
  interactive: boolean;
  reducedMotion: boolean;
  sharkCount: number;
  species: string;
  speed: number;
}

export function sharkRoster(species: string, count: number): SharkSpec[] {
  return Array.from(
    { length: Math.min(4, Math.max(1, Math.round(count))) },
    (_, i) => ({
      kind:
        species === "mixed"
          ? MIXED[i]
          : (KINDS.find((kind) => kind === species) ?? "classic"),
      size: 1 - i * 0.12,
    })
  );
}

/** Follow transparent layout boxes back to the workspace background. */
export function isOceanBackground(target: EventTarget | null): boolean {
  if (
    !(target instanceof HTMLElement && target.matches(BACKGROUND_LAYOUT)) ||
    target.closest(FOREGROUND_AREA)
  ) {
    return false;
  }

  const workspace = target.closest(BACKGROUND_AREA);
  if (
    !workspace ||
    Array.from(target.childNodes).some(
      (child) => child.nodeType === Node.TEXT_NODE && child.textContent?.trim()
    )
  ) {
    return false;
  }

  for (
    let element: HTMLElement | null = target;
    element;
    element = element.parentElement
  ) {
    if (element.matches('[role]:not([role="none"], [role="presentation"])')) {
      return false;
    }
    const { backgroundColor, backgroundImage, cursor } =
      getComputedStyle(element);
    if (
      (backgroundColor &&
        backgroundColor !== "rgba(0, 0, 0, 0)" &&
        backgroundColor !== "transparent") ||
      (backgroundImage && backgroundImage !== "none") ||
      cursor === "pointer"
    ) {
      return false;
    }
    if (element === workspace) {
      return true;
    }
  }
  return false;
}

export class OceanEngine {
  private readonly canvas: HTMLCanvasElement;
  private options: OceanOptions;
  private readonly onError: (error: unknown) => void;
  private readonly world: World;
  private readonly renderer: AsciiRenderer;
  private readonly resizeObserver: ResizeObserver;
  private readonly intersectionObserver: IntersectionObserver;
  private readonly motion = window.matchMedia(
    "(prefers-reduced-motion: reduce)"
  );
  // biome-ignore lint/style/useReadonlyClassProperties: assigned inside guarded animation callbacks.
  private raf = 0;
  // biome-ignore lint/style/useReadonlyClassProperties: assigned inside guarded animation callbacks.
  private last = 0;
  // biome-ignore lint/style/useReadonlyClassProperties: assigned inside guarded animation callbacks.
  private acc = 0;
  private visible = true;
  private disposed = false;
  private dragging = false;
  private pointerStart: { x: number; y: number; id: number } | null = null;

  constructor(
    canvas: HTMLCanvasElement,
    options: OceanOptions,
    onError: (error: unknown) => void
  ) {
    this.canvas = canvas;
    this.options = options;
    this.onError = onError;
    this.world = new World(
      sharkRoster(options.species, options.sharkCount),
      options.fishCount
    );
    this.renderer = new AsciiRenderer(canvas);
    this.renderer.setFontFamily(getComputedStyle(canvas).fontFamily);
    this.renderer.setDark(options.dark);
    this.resizeObserver = new ResizeObserver(this.resize);
    this.intersectionObserver = new IntersectionObserver(([entry]) => {
      this.visible = entry?.isIntersecting ?? false;
      this.sync();
    });
    this.resizeObserver.observe(canvas);
    this.intersectionObserver.observe(canvas);
    this.motion.addEventListener("change", this.sync);
    document.addEventListener("visibilitychange", this.sync);
    window.addEventListener("pointermove", this.pointerMove, { passive: true });
    window.addEventListener("pointerdown", this.pointerDown, { passive: true });
    window.addEventListener("pointerup", this.pointerUp, { passive: true });
    window.addEventListener("pointercancel", this.pointerLeave);
    window.addEventListener("blur", this.dragEnd);
    document.documentElement.addEventListener(
      "pointerleave",
      this.pointerLeave
    );
    window.addEventListener("dragstart", this.dragStart, true);
    window.addEventListener("dragenter", this.dragStart, true);
    window.addEventListener("dragleave", this.dragLeave, true);
    window.addEventListener("dragend", this.dragEnd, true);
    window.addEventListener("drop", this.dragEnd, true);
    this.resize();
    this.sync();
    document.fonts
      ?.load(`600 16px ${getComputedStyle(canvas).fontFamily}`)
      .then(() => {
        if (!this.disposed) {
          this.resize();
        }
      })
      .catch(() => undefined);
  }

  setOptions(options: OceanOptions) {
    this.options = options;
    this.renderer.setDark(options.dark);
    this.sync();
  }

  private get reduced() {
    return this.options.reducedMotion || this.motion.matches;
  }

  private guard(action: () => void) {
    if (this.disposed) {
      return;
    }
    try {
      action();
    } catch (error) {
      this.destroy();
      this.onError(error);
    }
  }

  private readonly resize = () =>
    this.guard(() => {
      const { width, height } = this.canvas.getBoundingClientRect();
      if (width < 1 || height < 1) {
        return;
      }
      const scale = Math.min(1, 1600 / width, 1000 / height);
      this.renderer.resize(
        width * scale,
        height * scale,
        Math.min(window.devicePixelRatio || 1, 1.5)
      );
      this.world.resize(
        width * scale,
        height * scale,
        this.renderer.cellWidth,
        this.renderer.cellHeight
      );
      this.drawStill();
    });

  private readonly sync = () =>
    this.guard(() => {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
      this.last = 0;
      this.acc = 0;
      this.pointerLeave();
      if (document.visibilityState !== "visible" || !this.visible) {
        return;
      }
      if (this.reduced) {
        this.drawStill();
      } else {
        this.raf = requestAnimationFrame(this.frame);
      }
    });

  private readonly frame = (now: number) =>
    this.guard(() => {
      if (!this.last) {
        this.last = now;
      }
      const elapsed = now - this.last;
      if (elapsed >= FRAME_MS) {
        this.last = now;
        const dt = Math.min(elapsed / 1000, 0.1) * this.options.speed;
        this.acc += dt;
        let steps = 0;
        while (this.acc >= STEP && steps < 6) {
          this.world.step(STEP);
          this.acc -= STEP;
          steps++;
        }
        if (steps === 6) {
          this.acc = 0;
        }
        this.renderer.render(this.world, dt);
      }
      this.raf = requestAnimationFrame(this.frame);
    });

  private drawStill() {
    if (this.world.time < 4) {
      for (let i = 0; i < 240; i++) {
        this.world.step(STEP);
      }
    }
    this.renderer.render(this.world, STEP);
  }

  private local(event: PointerEvent) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) * this.world.width) / rect.width,
      y: ((event.clientY - rect.top) * this.world.height) / rect.height,
    };
  }

  private canInteract(event: PointerEvent) {
    return (
      this.options.interactive &&
      !this.reduced &&
      !this.dragging &&
      event.buttons === 0 &&
      event.pointerType !== "touch" &&
      isOceanBackground(event.target)
    );
  }

  private readonly pointerMove = (event: PointerEvent) => {
    if (
      this.pointerStart &&
      Math.hypot(
        event.clientX - this.pointerStart.x,
        event.clientY - this.pointerStart.y
      ) > 4
    ) {
      this.pointerStart = null;
    }
    this.world.pointer.active = this.canInteract(event);
    if (this.world.pointer.active) {
      Object.assign(this.world.pointer, this.local(event));
    }
  };

  private readonly pointerDown = (event: PointerEvent) => {
    this.pointerLeave();
    if (
      event.button !== 0 ||
      !this.options.interactive ||
      this.reduced ||
      this.dragging ||
      !isOceanBackground(event.target)
    ) {
      return;
    }
    this.pointerStart = {
      x: event.clientX,
      y: event.clientY,
      id: event.pointerId,
    };
  };

  private readonly pointerUp = (event: PointerEvent) =>
    this.guard(() => {
      const start = this.pointerStart;
      this.pointerStart = null;
      if (
        !start ||
        start.id !== event.pointerId ||
        !this.canInteract(event) ||
        Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4
      ) {
        return;
      }
      const { x, y } = this.local(event);
      this.world.splash(x, y);
    });

  private readonly pointerLeave = () => {
    this.world.pointer.active = false;
    this.pointerStart = null;
  };
  private readonly dragStart = () => {
    this.dragging = true;
    this.pointerLeave();
  };

  private readonly dragLeave = (event: DragEvent) => {
    const next = event.relatedTarget;
    if (!(next instanceof Node && document.documentElement.contains(next))) {
      this.dragEnd();
    }
  };
  private readonly dragEnd = () => {
    this.dragging = false;
    this.pointerLeave();
  };

  destroy() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    this.intersectionObserver.disconnect();
    this.motion.removeEventListener("change", this.sync);
    document.removeEventListener("visibilitychange", this.sync);
    window.removeEventListener("pointermove", this.pointerMove);
    window.removeEventListener("pointerdown", this.pointerDown);
    window.removeEventListener("pointerup", this.pointerUp);
    window.removeEventListener("pointercancel", this.pointerLeave);
    window.removeEventListener("blur", this.dragEnd);
    document.documentElement.removeEventListener(
      "pointerleave",
      this.pointerLeave
    );
    window.removeEventListener("dragstart", this.dragStart, true);
    window.removeEventListener("dragenter", this.dragStart, true);
    window.removeEventListener("dragleave", this.dragLeave, true);
    window.removeEventListener("dragend", this.dragEnd, true);
    window.removeEventListener("drop", this.dragEnd, true);
    this.renderer.dispose();
    this.world.fish = [];
    this.world.sharks = [];
    this.world.events = [];
  }
}
