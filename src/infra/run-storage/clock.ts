export interface RunStorageClock {
  now(): number;
}

const readSystemTime = Date.now.bind(Date);

export const SYSTEM_RUN_STORAGE_CLOCK: RunStorageClock = Object.freeze({
  now(): number {
    return readSystemTime();
  },
});

export function readClock(clock: RunStorageClock): number {
  const now = clock.now();
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new Error('Run storage clock must return a non-negative safe integer');
  }
  return now;
}
