import { describe, expect, it } from "vitest";
import { PrioritySemaphore } from "@/utils/priority-semaphore";

describe("thumbnail generation priority", () => {
  it("promotes shared queued work without admitting more than the budget", async () => {
    const slots = new PrioritySemaphore(1);
    await slots.acquire();
    const order: string[] = [];
    const first = new AbortController();
    const second = new AbortController();
    const one = slots.acquire(first.signal, 2).then(() => order.push("one"));
    const two = slots.acquire(second.signal, 2).then(() => order.push("two"));
    slots.promote(second.signal, 0);
    expect(order).toEqual([]);
    slots.release();
    await two;
    expect(order).toEqual(["two"]);
    slots.release();
    await one;
    expect(order).toEqual(["two", "one"]);
    slots.release();
  });

  it("removes cancelled queued work after promotion", async () => {
    const slots = new PrioritySemaphore(1);
    await slots.acquire();
    const controller = new AbortController();
    const queued = slots.acquire(controller.signal, 2);
    const rejected = expect(queued).rejects.toMatchObject({
      name: "AbortError",
    });
    slots.promote(controller.signal, 0);
    controller.abort();
    await rejected;
    slots.release();
    await slots.acquire();
    slots.release();
  });
});
