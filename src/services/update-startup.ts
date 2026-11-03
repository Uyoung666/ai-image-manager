import { randomUUID } from "node:crypto";

export const UPDATE_CONFIRMATION_TIMEOUT_MS = 120_000;
export const UPDATE_CONFIRMATION_OBSERVATION_MS = 5000;

/** Only the current document may acknowledge readiness; elapsed time excludes sleep. */
export class UpdateStartupConfirmation {
  private nonce = randomUUID();
  private ready = false;
  private critical: boolean | undefined;
  private paused = false;
  private elapsed = 0;
  private observed = 0;
  private lastTick = Date.now();
  private timer: ReturnType<typeof setInterval> | undefined;
  private active = false;
  private readonly complete: () => void;
  private readonly failure: () => void;
  constructor(complete: () => void, failure: () => void) {
    this.complete = complete;
    this.failure = failure;
  }

  begin(): void {
    this.stop();
    this.documentChanged();
    this.active = true;
    this.elapsed = 0;
    this.observed = 0;
    this.lastTick = Date.now();
    if (this.critical === false) {
      this.fail();
      return;
    }
    this.timer = setInterval(() => this.tick(), 250);
    this.timer.unref?.();
  }
  context(): { nonce: string } | null {
    return this.active ? { nonce: this.nonce } : null;
  }
  documentChanged(): void {
    this.nonce = randomUUID();
    this.ready = false;
    this.observed = 0;
  }
  acknowledge(nonce: string): boolean {
    this.tick();
    if (!this.active || this.ready || nonce !== this.nonce) {
      return false;
    }
    this.ready = true;
    this.observed = 0;
    this.lastTick = Date.now();
    return true;
  }
  criticalReady(ready: boolean): void {
    if (ready) {
      if (!this.critical) {
        this.tick();
      }
      this.critical = true;
    } else {
      this.critical = false;
      this.fail();
    }
  }
  suspend(): void {
    this.tick();
    this.paused = true;
  }
  resume(): void {
    this.lastTick = Date.now();
    this.paused = false;
  }
  fail(): void {
    if (this.active) {
      this.stop();
      this.failure();
    }
  }
  stop(): void {
    this.active = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
  private tick(): void {
    const now = Date.now();
    const delta = Math.max(0, now - this.lastTick);
    this.lastTick = now;
    if (!this.active || this.paused) {
      return;
    }
    this.elapsed += delta;
    if (this.ready && this.critical) {
      this.observed += delta;
    }
    if (this.elapsed >= UPDATE_CONFIRMATION_TIMEOUT_MS) {
      this.fail();
    } else if (this.observed >= UPDATE_CONFIRMATION_OBSERVATION_MS) {
      this.stop();
      this.complete();
    }
  }
}
