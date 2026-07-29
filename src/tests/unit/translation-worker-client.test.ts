import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  existsSync: vi.fn(() => true),
  fork: vi.fn(),
}));

vi.mock("node:fs", () => ({
  default: {
    existsSync: mocks.existsSync,
  },
}));

vi.mock("node:child_process", () => ({
  default: {
    fork: mocks.fork,
  },
  fork: mocks.fork,
}));

vi.mock("electron", () => ({
  app: {
    getAppPath: () => "D:\\app",
    isPackaged: false,
  },
}));

vi.mock("@/services/ai/model-loader", () => ({
  ensureLocalModel: vi.fn().mockResolvedValue("D:\\models"),
}));

import {
  _resetTranslationClientForTest,
  getTranslationState,
  initTranslationWorker,
  translateChineseToEnglish,
} from "@/services/ai/translation-worker-client";

type Handler = (...args: any[]) => void;

function createWorker(options?: {
  empty?: boolean;
  hold?: boolean;
  translation?: string;
}) {
  const handlers = new Map<string, Handler[]>();
  const worker = {
    connected: true,
    kill: vi.fn(),
    on: vi.fn((event: string, handler: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return worker;
    }),
    send: vi.fn((message: any) => {
      if (message.type === "init") {
        queueMicrotask(() => emit("message", { type: "ready" }));
      }
      if (message.type === "translate" && !options?.hold) {
        queueMicrotask(() =>
          emit("message", {
            type: "result",
            requestId: message.requestId,
            text: options?.empty ? "" : (options?.translation ?? "three cats"),
          })
        );
      }
      if (message.type === "shutdown") {
        worker.connected = false;
      }
      return true;
    }),
  };
  const emit = (event: string, ...args: any[]): void => {
    for (const handler of handlers.get(event) ?? []) {
      handler(...args);
    }
  };
  return { emit, worker };
}

beforeEach(() => {
  vi.useRealTimers();
  mocks.existsSync.mockReturnValue(true);
  mocks.fork.mockReset();
  _resetTranslationClientForTest();
});

afterEach(() => {
  _resetTranslationClientForTest();
  vi.useRealTimers();
});

describe("translation worker client", () => {
  it("并发初始化共享同一个 Promise 和同一个 worker", async () => {
    const { worker } = createWorker();
    mocks.fork.mockReturnValue(worker);

    const first = initTranslationWorker("D:\\models");
    const second = initTranslationWorker("D:\\models");

    expect(first).toBe(second);
    await Promise.all([first, second]);
    expect(mocks.fork).toHaveBeenCalledOnce();
    expect(getTranslationState()).toBe("ready");
  });

  it("相同查询共享进行中任务并命中 LRU 缓存", async () => {
    const { worker } = createWorker({ translation: "cute kitten" });
    mocks.fork.mockReturnValue(worker);

    const [first, second] = await Promise.all([
      translateChineseToEnglish("可爱猫咪"),
      translateChineseToEnglish("可爱猫咪"),
    ]);
    const third = await translateChineseToEnglish("可爱猫咪");
    const translationCalls = worker.send.mock.calls.filter(
      ([message]) => message.type === "translate"
    );

    expect(first).toBe("cute kitten");
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(translationCalls).toHaveLength(1);
  });

  it("空输出不会写入缓存，交由查询计划降级", async () => {
    const { worker } = createWorker({ empty: true });
    mocks.fork.mockReturnValue(worker);

    await expect(translateChineseToEnglish("空输出测试")).rejects.toThrow(
      "empty"
    );
    await expect(translateChineseToEnglish("空输出测试")).rejects.toThrow(
      "empty"
    );
    expect(
      worker.send.mock.calls.filter(([message]) => message.type === "translate")
    ).toHaveLength(2);
  });

  it("请求超时后拒绝但不阻塞后续降级", async () => {
    vi.useFakeTimers();
    const { worker } = createWorker({ hold: true });
    mocks.fork.mockReturnValue(worker);

    const request = translateChineseToEnglish("超时测试");
    const assertion = expect(request).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(8001);

    await assertion;
  });

  it("worker 崩溃时拒绝所有请求并标记 error", async () => {
    const { emit, worker } = createWorker({ hold: true });
    mocks.fork.mockReturnValue(worker);

    await initTranslationWorker("D:\\models");
    const request = translateChineseToEnglish("崩溃测试");
    const assertion = expect(request).rejects.toThrow("exited with code 1");
    for (let attempt = 0; attempt < 10; attempt++) {
      if (
        worker.send.mock.calls.some(([message]) => message.type === "translate")
      ) {
        break;
      }
      await Promise.resolve();
    }
    emit("exit", 1);

    await assertion;
    expect(getTranslationState()).toBe("error");
  });

  it("空闲十五分钟后主动关闭 worker", async () => {
    vi.useFakeTimers();
    const { worker } = createWorker();
    mocks.fork.mockReturnValue(worker);

    await translateChineseToEnglish("空闲关闭测试");
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);

    expect(
      worker.send.mock.calls.some(([message]) => message.type === "shutdown")
    ).toBe(true);
    expect(getTranslationState()).toBe("degraded");
  });
});
