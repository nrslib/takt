import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { restoreStdin, setupRawStdin } from './helpers/stdinSimulator.js';

const { mockCreateInterface } = vi.hoisted(() => ({
  mockCreateInterface: vi.fn(),
}));

vi.mock('node:readline', () => ({
  createInterface: mockCreateInterface,
}));

import { confirmWithCancel } from '../shared/prompt/confirm.js';

describe('cancellable confirmations with piped input', () => {
  let originalStdinIsTTYDescriptor: PropertyDescriptor | undefined;
  let originalNoTty: string | undefined;
  let originalForceTty: string | undefined;

  beforeEach(() => {
    originalStdinIsTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    originalNoTty = process.env.TAKT_NO_TTY;
    originalForceTty = process.env.TAKT_TEST_FLG_TOUCH_TTY;
    setupRawStdin([]);
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    process.env.TAKT_NO_TTY = '1';
    delete process.env.TAKT_TEST_FLG_TOUCH_TTY;
    mockCreateInterface.mockReset();
  });

  afterEach(() => {
    restoreStdin();
    if (originalStdinIsTTYDescriptor === undefined) {
      Reflect.deleteProperty(process.stdin, 'isTTY');
    } else {
      Object.defineProperty(process.stdin, 'isTTY', originalStdinIsTTYDescriptor);
    }
    if (originalNoTty === undefined) {
      delete process.env.TAKT_NO_TTY;
    } else {
      process.env.TAKT_NO_TTY = originalNoTty;
    }
    if (originalForceTty === undefined) {
      delete process.env.TAKT_TEST_FLG_TOUCH_TTY;
    } else {
      process.env.TAKT_TEST_FLG_TOUCH_TTY = originalForceTty;
    }
  });

  it('uses the piped confirmation answer without entering raw mode', async () => {
    let lineHandler: ((line: string) => void) | undefined;
    let closeHandler: (() => void) | undefined;
    mockCreateInterface.mockImplementation(() => ({
      on: (event: string, callback: (...args: unknown[]) => void) => {
        if (event === 'line') lineHandler = (line: unknown) => callback(line);
        if (event === 'close') closeHandler = () => callback();
      },
    }));

    const confirmation = confirmWithCancel('Continue?', false);
    await Promise.resolve();

    expect(lineHandler).toBeDefined();
    expect(closeHandler).toBeDefined();
    lineHandler?.('y');
    closeHandler?.();

    await expect(confirmation).resolves.toEqual({ kind: 'value', value: true });
    expect(mockCreateInterface).toHaveBeenCalledOnce();
    expect(process.stdin.setRawMode).not.toHaveBeenCalled();
  });
});
