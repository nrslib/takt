import type { RunStorageClock } from '../../infra/run-storage/clock.js';

class TestRunStorageClock implements RunStorageClock {
  #current = 1_000;
  #queued: number[] = [];

  now(): number {
    return this.#queued.shift() ?? this.#current;
  }

  set(now: number): void {
    this.#current = now;
    this.#queued = [];
  }

  queue(...times: number[]): void {
    this.#queued = [...times];
  }
}

export const TEST_RUN_STORAGE_CLOCK = new TestRunStorageClock();
