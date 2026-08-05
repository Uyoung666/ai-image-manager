import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { WanderLifecycleState } from "@/constants";
import { createWanderLifecycleBridge } from "@/services/wander-lifecycle";

class FakeWindow extends EventEmitter {
  focused = true;
  minimized = false;
  visible = true;

  isFocused() {
    return this.focused;
  }

  isMinimized() {
    return this.minimized;
  }

  isVisible() {
    return this.visible;
  }
}

class FakePowerMonitor extends EventEmitter {
  idleState: "active" | "idle" | "locked" = "active";

  getSystemIdleState() {
    return this.idleState;
  }
}

function setup() {
  const window = new FakeWindow();
  const powerMonitor = new FakePowerMonitor();
  const sent: WanderLifecycleState[] = [];
  const bridge = createWanderLifecycleBridge({
    powerMonitor,
    send: (state) => sent.push(state),
    window,
  });
  return { bridge, powerMonitor, sent, window };
}

describe("wander lifecycle bridge", () => {
  it("publishes the initial eligible state on demand", () => {
    const { bridge, sent } = setup();

    bridge.publish();

    expect(sent).toEqual([
      expect.objectContaining({
        channel: "wander:lifecycle",
        eligible: true,
        reason: "initial",
      }),
    ]);
  });

  it.each([
    ["blur", "window-blur"],
    ["hide", "window-hide"],
    ["minimize", "window-minimize"],
  ] as const)("makes the app ineligible on window %s", (event, reason) => {
    const { sent, window } = setup();

    window.emit(event);

    expect(sent.at(-1)).toMatchObject({ eligible: false, reason });
  });

  it("requires all window conditions before becoming eligible again", () => {
    const { sent, window } = setup();

    window.emit("blur");
    window.emit("hide");
    window.emit("minimize");
    window.emit("show");
    window.emit("restore");

    expect(sent.at(-1)).toMatchObject({ eligible: false });

    window.emit("focus");

    expect(sent.at(-1)).toMatchObject({
      eligible: true,
      reason: "window-focus",
    });
  });

  it("blocks while the system is locked or suspended", () => {
    const { powerMonitor, sent } = setup();

    powerMonitor.emit("lock-screen");
    expect(sent.at(-1)).toMatchObject({
      eligible: false,
      locked: true,
      reason: "system-lock",
    });

    powerMonitor.emit("unlock-screen");
    expect(sent.at(-1)).toMatchObject({
      eligible: true,
      locked: false,
      reason: "system-unlock",
    });

    powerMonitor.emit("suspend");
    expect(sent.at(-1)).toMatchObject({
      eligible: false,
      reason: "system-suspend",
      suspended: true,
    });

    powerMonitor.emit("resume");
    expect(sent.at(-1)).toMatchObject({
      eligible: true,
      reason: "system-resume",
      suspended: false,
    });
  });

  it("uses an available initial system lock state", () => {
    const window = new FakeWindow();
    const powerMonitor = new FakePowerMonitor();
    powerMonitor.idleState = "locked";
    const bridge = createWanderLifecycleBridge({
      powerMonitor,
      send: vi.fn(),
      window,
    });

    expect(bridge.getState()).toMatchObject({
      eligible: false,
      locked: true,
    });
  });

  it("removes every listener when disposed", () => {
    const { bridge, powerMonitor, sent, window } = setup();

    bridge.dispose();
    window.emit("blur");
    powerMonitor.emit("lock-screen");

    expect(sent).toEqual([]);
    expect(window.listenerCount("blur")).toBe(0);
    expect(powerMonitor.listenerCount("lock-screen")).toBe(0);
  });
});
