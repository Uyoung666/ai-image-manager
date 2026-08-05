import {
  IPC_CHANNELS,
  type WanderLifecycleReason,
  type WanderLifecycleState,
} from "@/constants";

type EventListener = (...args: unknown[]) => void;

interface EventSource {
  on(event: string, listener: EventListener): unknown;
  removeListener(event: string, listener: EventListener): unknown;
}

interface WanderWindow extends EventSource {
  isFocused(): boolean;
  isMinimized(): boolean;
  isVisible(): boolean;
}

interface WanderPowerMonitor extends EventSource {
  getSystemIdleState?(
    idleThreshold: number
  ): "active" | "idle" | "locked" | "unknown";
}

export interface WanderLifecycleBridge {
  dispose(): void;
  getState(reason?: WanderLifecycleReason): WanderLifecycleState;
  publish(reason?: WanderLifecycleReason): void;
}

interface CreateWanderLifecycleBridgeOptions {
  powerMonitor: WanderPowerMonitor;
  send(state: WanderLifecycleState): void;
  window: WanderWindow;
}

/** Mirrors Electron window and OS state into renderer eligibility snapshots. */
export function createWanderLifecycleBridge({
  powerMonitor,
  send,
  window,
}: CreateWanderLifecycleBridgeOptions): WanderLifecycleBridge {
  let focused = window.isFocused();
  let minimized = window.isMinimized();
  let visible = window.isVisible();
  let locked = false;
  let suspended = false;

  try {
    locked = powerMonitor.getSystemIdleState?.(1) === "locked";
  } catch {
    // Some platforms cannot report current lock state. Events still update it.
  }

  const getState = (
    reason: WanderLifecycleReason = "initial"
  ): WanderLifecycleState => ({
    channel: IPC_CHANNELS.WANDER_LIFECYCLE,
    eligible: visible && focused && !minimized && !locked && !suspended,
    focused,
    locked,
    minimized,
    reason,
    suspended,
    visible,
  });

  const publish = (reason: WanderLifecycleReason = "initial") => {
    send(getState(reason));
  };

  const listeners: Array<{
    event: string;
    listener: EventListener;
    source: EventSource;
  }> = [];

  const listen = (
    source: EventSource,
    event: string,
    reason: WanderLifecycleReason,
    update: () => void
  ) => {
    const listener = () => {
      update();
      publish(reason);
    };
    listeners.push({ event, listener, source });
    source.on(event, listener);
  };

  listen(window, "blur", "window-blur", () => {
    focused = false;
  });
  listen(window, "focus", "window-focus", () => {
    focused = true;
  });
  listen(window, "hide", "window-hide", () => {
    visible = false;
  });
  listen(window, "show", "window-show", () => {
    visible = true;
  });
  listen(window, "minimize", "window-minimize", () => {
    minimized = true;
  });
  listen(window, "restore", "window-restore", () => {
    minimized = false;
  });
  listen(powerMonitor, "lock-screen", "system-lock", () => {
    locked = true;
  });
  listen(powerMonitor, "unlock-screen", "system-unlock", () => {
    locked = false;
  });
  listen(powerMonitor, "suspend", "system-suspend", () => {
    suspended = true;
  });
  listen(powerMonitor, "resume", "system-resume", () => {
    suspended = false;
  });

  return {
    dispose() {
      for (const { event, listener, source } of listeners) {
        source.removeListener(event, listener);
      }
      listeners.length = 0;
    },
    getState,
    publish,
  };
}
