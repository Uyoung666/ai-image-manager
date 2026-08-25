export interface TrayLifecycleHandle {
  destroy(): void;
}

export interface WindowLifecycleHandle {
  focus(): void;
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
}

export interface QuitEventHandle {
  preventDefault(): void;
}

/**
 * Mark the application as quitting and tear down the tray immediately.
 *
 * Windows can keep a notification-area icon around until the owning process
 * exits.  Destroying the Tray in the before-quit phase (rather than waiting
 * for will-quit cleanup) closes the race where a window close has already
 * requested shutdown but the stale tray menu is still visible.
 */
export function prepareForQuit({
  destroyTray,
  markQuitting,
}: {
  destroyTray: () => void;
  markQuitting: () => void;
}): void {
  markQuitting();
  destroyTray();
}

/**
 * Coordinate Electron's two-pass quit sequence.
 *
 * The first before-quit event is cancelled while asynchronous cleanup runs.
 * Once cleanup settles, requestQuit triggers a second before-quit event, which
 * is allowed through. Electron does not await promises returned by event
 * listeners, so an async listener without this coordinator can orphan Windows
 * worker processes after the UI and tray have already disappeared.
 */
export function createBeforeQuitHandler({
  cleanup,
  destroyTray,
  markQuitting,
  onCleanupError,
  requestQuit,
}: {
  cleanup: () => Promise<void>;
  destroyTray: () => void;
  markQuitting: () => void;
  onCleanupError: (error: unknown) => void;
  requestQuit: () => void;
}): (event: QuitEventHandle) => void {
  let state: "idle" | "cleaning" | "ready" = "idle";

  return (event) => {
    markQuitting();
    destroyTray();

    if (state === "ready") {
      return;
    }

    event.preventDefault();
    if (state === "cleaning") {
      return;
    }

    state = "cleaning";
    cleanup()
      .catch(onCleanupError)
      .finally(() => {
        state = "ready";
        requestQuit();
      });
  };
}

export function destroyTraySafely(
  tray: TrayLifecycleHandle | null,
  onError: (error: unknown) => void
): boolean {
  if (!tray) {
    return true;
  }

  try {
    tray.destroy();
    return true;
  } catch (error) {
    onError(error);
    return false;
  }
}

export function showOrCreateWindow<TWindow extends WindowLifecycleHandle>({
  createWindow,
  isQuitting,
  window,
}: {
  createWindow: () => void;
  isQuitting: boolean;
  window: TWindow | null;
}): void {
  if (isQuitting) {
    return;
  }

  if (!window || window.isDestroyed()) {
    createWindow();
    return;
  }

  if (window.isMinimized()) {
    window.restore();
  }
  window.show();
  window.focus();
}
