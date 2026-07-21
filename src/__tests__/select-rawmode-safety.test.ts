import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SelectOptionItem } from '../shared/prompt/select.js';
import { handleKeyInput, selectOption } from '../shared/prompt/select.js';
import { restoreStdin, setupRawStdin } from './helpers/stdinSimulator.js';

describe('select raw mode safety', () => {
  const originalNoTty = process.env.TAKT_NO_TTY;
  const originalTouchTty = process.env.TAKT_TEST_FLG_TOUCH_TTY;

  beforeEach(() => {
    delete process.env.TAKT_NO_TTY;
    process.env.TAKT_TEST_FLG_TOUCH_TTY = '1';
  });

  afterEach(() => {
    restoreStdin();
    if (originalNoTty === undefined) {
      delete process.env.TAKT_NO_TTY;
    } else {
      process.env.TAKT_NO_TTY = originalNoTty;
    }
    if (originalTouchTty === undefined) {
      delete process.env.TAKT_TEST_FLG_TOUCH_TTY;
    } else {
      process.env.TAKT_TEST_FLG_TOUCH_TTY = originalTouchTty;
    }
  });

  describe('handleKeyInput Ctrl+C handling', () => {
    it('should return exit action for Ctrl+C (\\x03)', () => {
      const result = handleKeyInput('\x03', 0, 3, true, 2);
      expect(result).toEqual({ action: 'exit' });
    });

    it('should return exit action regardless of current selection', () => {
      const result = handleKeyInput('\x03', 2, 4, true, 3);
      expect(result).toEqual({ action: 'exit' });
    });

    it('should exit with code 130 after successful cleanup', async () => {
      const options: SelectOptionItem<string>[] = [{ label: 'A', value: 'a' }];
      const exitError = new Error('process.exit called');
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw exitError;
      });
      setupRawStdin(['\x03']);

      await expect(selectOption('Select option', options)).rejects.toThrow(exitError);

      expect(process.stdin.setRawMode).toHaveBeenLastCalledWith(false);
      expect(process.stdin.pause).toHaveBeenCalledOnce();
      expect(exitSpy).toHaveBeenCalledWith(130);
    });

    it('should stop processing a stdin chunk after Ctrl+C', async () => {
      const options: SelectOptionItem<string>[] = [{ label: 'A', value: 'a' }];
      const exitError = new Error('process.exit called');
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw exitError;
      });
      setupRawStdin(['\x03 ']);

      await expect(selectOption('Select option', options)).rejects.toThrow(exitError);

      expect(exitSpy).toHaveBeenCalledOnce();
      expect(exitSpy).toHaveBeenCalledWith(130);
    });

    it('should process Ctrl+C after an incomplete CSI sequence', async () => {
      const options: SelectOptionItem<string>[] = [{ label: 'A', value: 'a' }];
      const exitError = new Error('process.exit called');
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw exitError;
      });
      setupRawStdin(['\x1B[', '1\x03'], { continuous: true });

      await expect(selectOption('Select option', options)).rejects.toThrow(exitError);

      expect(exitSpy).toHaveBeenCalledOnce();
      expect(exitSpy).toHaveBeenCalledWith(130);
    });

    it('should reject every cleanup error instead of exiting on Ctrl+C', async () => {
      const options: SelectOptionItem<string>[] = [{ label: 'A', value: 'a' }];
      const listenerError = new Error('listener cleanup failed');
      const rawModeError = new Error('raw mode cleanup failed');
      const pauseError = new Error('stdin pause failed');
      const cursorError = new Error('cursor cleanup failed');
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
      setupRawStdin(['\x03']);

      process.stdin.removeListener = vi.fn(() => {
        throw listenerError;
      }) as unknown as typeof process.stdin.removeListener;
      process.stdin.setRawMode = vi.fn((enabled: boolean) => {
        if (!enabled) throw rawModeError;
        (process.stdin as unknown as { isRaw: boolean }).isRaw = true;
        return process.stdin;
      }) as unknown as typeof process.stdin.setRawMode;
      process.stdin.pause = vi.fn(() => {
        throw pauseError;
      }) as unknown as typeof process.stdin.pause;
      process.stdout.write = vi.fn((chunk: string | Uint8Array) => {
        if (String(chunk) === '\x1B[?7h') throw cursorError;
        return true;
      }) as unknown as typeof process.stdout.write;

      await expect(selectOption('Select option', options)).rejects.toSatisfy((error: unknown) => {
        if (!(error instanceof AggregateError)) return false;
        return [listenerError, rawModeError, pauseError, cursorError]
          .every((expectedError) => error.errors.includes(expectedError));
      });

      expect(exitSpy).not.toHaveBeenCalled();
    });
  });

  describe('onKeyPress error safety (raw mode leak protection)', () => {
    it('should reject callback errors after restoring raw mode', async () => {
      const options: SelectOptionItem<string>[] = [
        { label: 'A', value: 'a' },
        { label: 'B', value: 'b' },
      ];
      const error = new Error('key handler failed');
      setupRawStdin([' ']);

      await expect(selectOption('Select option', options, {
        onKeyPress: () => {
          throw error;
        },
      })).rejects.toThrow(error);

      expect(process.stdin.setRawMode).toHaveBeenLastCalledWith(false);
      expect(process.stdin.pause).toHaveBeenCalledOnce();
    });

    it('should preserve handler and every cleanup error when they fail together', async () => {
      const options: SelectOptionItem<string>[] = [{ label: 'A', value: 'a' }];
      const handlerError = new Error('key handler failed');
      const listenerError = new Error('listener cleanup failed');
      const rawModeError = new Error('raw mode cleanup failed');
      const pauseError = new Error('stdin pause failed');
      const cursorError = new Error('cursor cleanup failed');
      setupRawStdin([' ']);

      process.stdin.removeListener = vi.fn(() => {
        throw listenerError;
      }) as unknown as typeof process.stdin.removeListener;
      process.stdin.setRawMode = vi.fn((enabled: boolean) => {
        if (!enabled) throw rawModeError;
        (process.stdin as unknown as { isRaw: boolean }).isRaw = true;
        return process.stdin;
      }) as unknown as typeof process.stdin.setRawMode;
      process.stdin.pause = vi.fn(() => {
        throw pauseError;
      }) as unknown as typeof process.stdin.pause;
      process.stdout.write = vi.fn((chunk: string | Uint8Array) => {
        if (String(chunk) === '\x1B[?7h') throw cursorError;
        return true;
      }) as unknown as typeof process.stdout.write;

      await expect(selectOption('Select option', options, {
        onKeyPress: () => {
          throw handlerError;
        },
      })).rejects.toSatisfy((error: unknown) => {
        if (!(error instanceof AggregateError)) return false;
        return [handlerError, listenerError, rawModeError, pauseError, cursorError]
          .every((expectedError) => error.errors.includes(expectedError));
      });

      expect(process.stdin.isRaw).toBe(true);
    });

    it('should reject redraw errors after restoring raw mode', async () => {
      const options: SelectOptionItem<string>[] = [
        { label: 'A', value: 'a' },
        { label: 'B', value: 'b' },
      ];
      const error = new Error('redraw failed');
      let writeCount = 0;
      setupRawStdin(['\x1B[B']);
      process.stdout.write = vi.fn(() => {
        writeCount += 1;
        if (writeCount === 3) throw error;
        return true;
      }) as unknown as typeof process.stdout.write;

      await expect(selectOption('Select option', options)).rejects.toThrow(error);

      expect(process.stdin.setRawMode).toHaveBeenLastCalledWith(false);
      expect(process.stdin.pause).toHaveBeenCalledOnce();
    });

    it('should restore cursor wrapping when raw mode initialization fails', async () => {
      const options: SelectOptionItem<string>[] = [{ label: 'A', value: 'a' }];
      const error = new Error('raw mode unavailable');
      setupRawStdin([]);
      process.stdin.setRawMode = vi.fn(() => {
        throw error;
      }) as unknown as typeof process.stdin.setRawMode;

      await expect(selectOption('Select option', options)).rejects.toThrow(error);

      const output = vi.mocked(process.stdout.write).mock.calls
        .map(([chunk]) => String(chunk))
        .join('');
      expect(output).toContain('\x1B[?7l');
      expect(output).toContain('\x1B[?7h');
    });

    it('should restore raw mode and cursor wrapping when stdin resume fails', async () => {
      const options: SelectOptionItem<string>[] = [{ label: 'A', value: 'a' }];
      const error = new Error('stdin resume failed');
      setupRawStdin([]);
      process.stdin.resume = vi.fn(() => {
        throw error;
      }) as unknown as typeof process.stdin.resume;

      await expect(selectOption('Select option', options)).rejects.toThrow(error);

      expect(process.stdin.setRawMode).toHaveBeenLastCalledWith(false);
      const output = vi.mocked(process.stdout.write).mock.calls
        .map(([chunk]) => String(chunk))
        .join('');
      expect(output).toContain('\x1B[?7h');
    });

    it('should restore a previously leaked raw mode state on the next prompt', async () => {
      const options: SelectOptionItem<string>[] = [{ label: 'A', value: 'a' }];
      setupRawStdin([]);
      let failRestore = true;
      process.stdin.resume = vi.fn(() => {
        throw new Error('stdin resume failed');
      }) as unknown as typeof process.stdin.resume;
      process.stdin.setRawMode = vi.fn((enabled: boolean) => {
        if (!enabled && failRestore) throw new Error('raw mode restore failed');
        (process.stdin as unknown as { isRaw: boolean }).isRaw = enabled;
        return process.stdin;
      }) as unknown as typeof process.stdin.setRawMode;

      await expect(selectOption('Select option', options)).rejects.toBeInstanceOf(AggregateError);
      expect(process.stdin.isRaw).toBe(true);

      failRestore = false;
      process.stdin.resume = vi.fn(() => process.stdin) as unknown as typeof process.stdin.resume;
      process.stdin.on = vi.fn(((event: string, handler: (data: Buffer) => void) => {
        if (event === 'data') {
          queueMicrotask(() => handler(Buffer.from('\x1B')));
        }
        return process.stdin;
      }) as typeof process.stdin.on);

      await expect(selectOption('Select option', options)).resolves.toBeNull();
      expect(process.stdin.isRaw).toBe(false);
    });

    it('should restore cursor wrapping when raw mode cleanup fails', async () => {
      const options: SelectOptionItem<string>[] = [{ label: 'A', value: 'a' }];
      const error = new Error('raw mode cleanup failed');
      setupRawStdin(['\x1B']);
      process.stdin.setRawMode = vi.fn((enabled: boolean) => {
        if (!enabled) throw error;
        return process.stdin;
      }) as unknown as typeof process.stdin.setRawMode;

      await expect(selectOption('Select option', options)).rejects.toThrow(error);

      const output = vi.mocked(process.stdout.write).mock.calls
        .map(([chunk]) => String(chunk))
        .join('');
      expect(output).toContain('\x1B[?7h');
    });

    it('should handle edge case inputs without throwing', () => {
      expect(() => handleKeyInput('\x03', 0, 0, false, 0)).not.toThrow();
      expect(() => handleKeyInput('\x1B[A', 0, 1, false, 1)).not.toThrow();
      expect(() => handleKeyInput('\r', 0, 1, true, 0)).not.toThrow();
    });
  });
});
