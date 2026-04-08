import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockWarn,
  mockError,
  mockBlankLine,
  mockGetLabel,
} = vi.hoisted(() => ({
  mockWarn: vi.fn(),
  mockError: vi.fn(),
  mockBlankLine: vi.fn(),
  mockGetLabel: vi.fn((key: string) => key),
}));

vi.mock('../shared/ui/index.js', () => ({
  warn: mockWarn,
  error: mockError,
  blankLine: mockBlankLine,
}));

vi.mock('../shared/i18n/index.js', () => ({
  getLabel: mockGetLabel,
}));

import { ShutdownManager } from '../features/tasks/execute/shutdownManager.js';

describe('ShutdownManager', () => {
  let savedSigintListeners: ((...args: unknown[]) => void)[];
  let originalShutdownTimeoutEnv: string | undefined;
  let originalNoTtyEnv: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    savedSigintListeners = process.rawListeners('SIGINT') as ((...args: unknown[]) => void)[];
    originalShutdownTimeoutEnv = process.env.TAKT_SHUTDOWN_TIMEOUT_MS;
    originalNoTtyEnv = process.env.TAKT_NO_TTY;
    delete process.env.TAKT_SHUTDOWN_TIMEOUT_MS;
    delete process.env.TAKT_NO_TTY;
  });

  afterEach(() => {
    vi.useRealTimers();
    process.removeAllListeners('SIGINT');
    for (const listener of savedSigintListeners) {
      process.on('SIGINT', listener as NodeJS.SignalsListener);
    }
    if (originalShutdownTimeoutEnv === undefined) {
      delete process.env.TAKT_SHUTDOWN_TIMEOUT_MS;
    } else {
      process.env.TAKT_SHUTDOWN_TIMEOUT_MS = originalShutdownTimeoutEnv;
    }
    if (originalNoTtyEnv === undefined) {
      delete process.env.TAKT_NO_TTY;
    } else {
      process.env.TAKT_NO_TTY = originalNoTtyEnv;
    }
  });

  it('1回目SIGINTでgracefulコールバックを呼ぶ', () => {
    const onGraceful = vi.fn();
    const onForceKill = vi.fn();

    const manager = new ShutdownManager({
      callbacks: { onGraceful, onForceKill },
      gracefulTimeoutMs: 1_000,
    });
    manager.install();

    const listeners = process.rawListeners('SIGINT') as Array<() => void>;
    listeners[listeners.length - 1]!();

    expect(onGraceful).toHaveBeenCalledTimes(1);
    expect(onForceKill).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledWith('workflow.sigintGraceful');

    manager.cleanup();
  });

  it('graceful timeoutでforceコールバックを呼ぶ', () => {
    vi.useFakeTimers();
    const onGraceful = vi.fn();
    const onForceKill = vi.fn();

    const manager = new ShutdownManager({
      callbacks: { onGraceful, onForceKill },
      gracefulTimeoutMs: 50,
    });
    manager.install();

    const listeners = process.rawListeners('SIGINT') as Array<() => void>;
    listeners[listeners.length - 1]!();
    vi.advanceTimersByTime(50);

    expect(onGraceful).toHaveBeenCalledTimes(1);
    expect(onForceKill).toHaveBeenCalledTimes(1);
    expect(mockError).toHaveBeenCalledWith('workflow.sigintTimeout');
    expect(mockError).toHaveBeenCalledWith('workflow.sigintForce');

    manager.cleanup();
  });

  it('2回目SIGINTで即時forceコールバックを呼び、timeoutを待たない', () => {
    vi.useFakeTimers();
    const onGraceful = vi.fn();
    const onForceKill = vi.fn();

    const manager = new ShutdownManager({
      callbacks: { onGraceful, onForceKill },
      gracefulTimeoutMs: 10_000,
    });
    manager.install();

    const listeners = process.rawListeners('SIGINT') as Array<() => void>;
    const handler = listeners[listeners.length - 1]!;
    handler();
    handler();
    vi.advanceTimersByTime(10_000);

    expect(onGraceful).toHaveBeenCalledTimes(1);
    expect(onForceKill).toHaveBeenCalledTimes(1);
    expect(mockError).toHaveBeenCalledWith('workflow.sigintForce');

    manager.cleanup();
  });

  it('環境変数未設定時は通常モードでデフォルト10_000msを使う', () => {
    vi.useFakeTimers();
    const onGraceful = vi.fn();
    const onForceKill = vi.fn();

    const manager = new ShutdownManager({
      callbacks: { onGraceful, onForceKill },
    });
    manager.install();

    const listeners = process.rawListeners('SIGINT') as Array<() => void>;
    listeners[listeners.length - 1]!();

    vi.advanceTimersByTime(9_999);
    expect(onForceKill).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onForceKill).toHaveBeenCalledTimes(1);

    manager.cleanup();
  });

  it('TAKT_NO_TTY=1 のときはデフォルト5_000msを使う', () => {
    vi.useFakeTimers();
    process.env.TAKT_NO_TTY = '1';
    const onGraceful = vi.fn();
    const onForceKill = vi.fn();

    const manager = new ShutdownManager({
      callbacks: { onGraceful, onForceKill },
    });
    manager.install();

    const listeners = process.rawListeners('SIGINT') as Array<() => void>;
    listeners[listeners.length - 1]!();

    vi.advanceTimersByTime(4_999);
    expect(onForceKill).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onForceKill).toHaveBeenCalledTimes(1);

    manager.cleanup();
  });

  it('環境変数設定時はその値をtimeoutとして使う', () => {
    vi.useFakeTimers();
    process.env.TAKT_SHUTDOWN_TIMEOUT_MS = '25';
    const onGraceful = vi.fn();
    const onForceKill = vi.fn();

    const manager = new ShutdownManager({
      callbacks: { onGraceful, onForceKill },
    });
    manager.install();

    const listeners = process.rawListeners('SIGINT') as Array<() => void>;
    listeners[listeners.length - 1]!();

    vi.advanceTimersByTime(24);
    expect(onForceKill).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onForceKill).toHaveBeenCalledTimes(1);

    manager.cleanup();
  });

  it('不正な環境変数値ではエラーをthrowする', () => {
    process.env.TAKT_SHUTDOWN_TIMEOUT_MS = '0';

    expect(
      () =>
        new ShutdownManager({
          callbacks: { onGraceful: vi.fn(), onForceKill: vi.fn() },
        }),
    ).toThrowError('TAKT_SHUTDOWN_TIMEOUT_MS must be a positive integer');
  });
});
