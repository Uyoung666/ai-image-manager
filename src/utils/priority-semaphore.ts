interface Waiter {
  priority: number;
  run: () => void;
  signal?: AbortSignal;
}

/** FIFO within a priority. Aborted queued work never consumes a slot. */
export class PrioritySemaphore {
  private running = 0;
  private readonly pending: Waiter[] = [];
  private readonly maximum: number;
  constructor(maximum: number) {
    this.maximum = maximum;
  }

  acquire(signal?: AbortSignal, priority = 2): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(new DOMException("Cancelled", "AbortError"));
    }
    if (this.running < this.maximum) {
      this.running++;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const cancel = () => {
        const index = this.pending.indexOf(waiter);
        if (index >= 0) {
          this.pending.splice(index, 1);
        }
        reject(new DOMException("Cancelled", "AbortError"));
      };
      const waiter = {
        priority,
        signal,
        run: () => {
          signal?.removeEventListener("abort", cancel);
          this.running++;
          resolve();
        },
      };
      signal?.addEventListener("abort", cancel, { once: true });
      this.pending.push(waiter);
      this.pending.sort((a, b) => a.priority - b.priority);
    });
  }

  promote(signal: AbortSignal, priority: number): void {
    const waiter = this.pending.find((entry) => entry.signal === signal);
    if (waiter && priority < waiter.priority) {
      waiter.priority = priority;
      this.pending.sort((a, b) => a.priority - b.priority);
    }
  }

  release(): void {
    this.running--;
    this.pending.shift()?.run();
  }
}
