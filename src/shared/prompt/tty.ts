export interface TtyPolicy {
  useTty: boolean;
  forceTouchTty: boolean;
}

export function resolveTtyPolicy(): TtyPolicy {
  const forceTouchTty = process.env.TAKT_TEST_FLG_TOUCH_TTY === '1';
  const forceNoTty = process.env.TAKT_NO_TTY === '1';
  const useTty = process.stdin.isTTY && (!forceNoTty || forceTouchTty);
  return { useTty, forceTouchTty };
}

export function assertTtyIfForced(forceTouchTty: boolean): void {
  if (forceTouchTty && !process.stdin.isTTY) {
    throw new Error('TAKT_TEST_FLG_TOUCH_TTY=1 requires a TTY');
  }
}
