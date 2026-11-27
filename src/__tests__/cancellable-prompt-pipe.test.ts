import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { confirm, confirmWithCancel } from '../shared/prompt/confirm.js';
import { readPipedLine } from '../features/interactive/lineEditor.js';

let input: PassThrough;
beforeEach(() => {
  input = new PassThrough();
  Object.defineProperty(input, 'isTTY', { value: false });
  vi.spyOn(process, 'stdin', 'get').mockReturnValue(input as unknown as typeof process.stdin);
  vi.stubEnv('TAKT_NO_TTY', '1');
  vi.stubEnv('TAKT_TEST_FLG_TOUCH_TTY', '0');
});
afterEach(() => {
  input.destroy();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('cancellable confirmations with piped input', () => {
  it('answers before EOF and passes later answers between conversation and confirmation', async () => {
    const confirmation = confirmWithCancel('Continue?', false);
    input.write('y\nnext conversation\nn\n');
    await expect(confirmation).resolves.toEqual({ kind: 'value', value: true });
    await expect(readPipedLine('> ')).resolves.toBe('next conversation');
    await expect(confirm('Worktree?', true)).resolves.toBe(false);
    input.end();
    await expect(readPipedLine('> ')).resolves.toBeNull();
  });

  it('preserves empty lines, queued answers after close, and EOF defaults', async () => {
    input.end('\nn\n');
    await expect(confirm('First?', true)).resolves.toBe(true);
    await expect(confirm('Second?', true)).resolves.toBe(false);
    await expect(confirm('EOF?', true)).resolves.toBe(true);
    await expect(confirm('EOF?', false)).resolves.toBe(false);
  });

  it('keeps signal confirmations denied without consuming pipe input', async () => {
    input.end('y\n');
    await expect(confirmWithCancel('Permission?', true, new AbortController().signal))
      .resolves.toEqual({ kind: 'value', value: false });
    await expect(confirm('Next?', false)).resolves.toBe(true);
  });

  it('keeps standalone Escape as a negative answer for the generic confirmation', async () => {
    input.end('\x1B\n');
    await expect(confirmWithCancel('Continue?', true)).resolves.toEqual({ kind: 'value', value: false });
  });
});
