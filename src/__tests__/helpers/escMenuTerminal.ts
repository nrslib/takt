import { PassThrough } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { expect, vi } from 'vitest';
import { ESCAPE_SEQUENCE_TIMEOUT_MS } from '../../shared/prompt/select-key-input.js';

class TerminalInput extends PassThrough {
  readonly isTTY = true;
  isRaw = false;

  setRawMode(mode: boolean): this {
    this.isRaw = mode;
    return this;
  }

  ref(): this {
    return this;
  }
}

export function createEscMenuTerminal() {
  const input = new TerminalInput();
  const stdinSpy = vi.spyOn(process, 'stdin', 'get').mockReturnValue(input as unknown as typeof process.stdin);
  const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
  vi.stubEnv('TAKT_NO_TTY', '0');
  vi.stubEnv('TAKT_TEST_FLG_TOUCH_TTY', '1');

  let output = '';
  const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    output += stripVTControlCharacters(String(chunk));
    return true;
  });
  const consoleSpies = (['log', 'info', 'warn', 'error'] as const).map((method) =>
    vi.spyOn(console, method).mockImplementation((...values: unknown[]) => {
      output += values.map(String).join(' ') + '\n';
    }),
  );

  return {
    input,
    output: () => output,
    mark: () => output.length,
    async waitForPrompt(message: string, since: number): Promise<void> {
      await vi.waitFor(() => {
        expect(output.slice(since)).toContain(message);
        expect(input.isPaused()).toBe(false);
        expect(input.listenerCount('data')).toBeGreaterThan(0);
      }, { interval: 10, timeout: 4 * ESCAPE_SEQUENCE_TIMEOUT_MS });
    },
    async send(bytes: string): Promise<void> {
      expect(!input.isPaused() || input.listenerCount('readable') > 0).toBe(true);
      input.write(bytes);
    },
    restore(): void {
      input.destroy();
      stdinSpy.mockRestore();
      writeSpy.mockRestore();
      for (const spy of consoleSpies) spy.mockRestore();
      if (ttyDescriptor === undefined) {
        Reflect.deleteProperty(process.stdout, 'isTTY');
      } else {
        Object.defineProperty(process.stdout, 'isTTY', ttyDescriptor);
      }
      vi.unstubAllEnvs();
    },
  };
}

export type EscMenuTerminal = ReturnType<typeof createEscMenuTerminal>;
