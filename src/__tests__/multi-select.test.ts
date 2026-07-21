import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import chalk from 'chalk';
import { selectMultipleOptions, type SelectOptionItem } from '../shared/prompt/index.js';
import { restoreStdin, setupRawStdin } from './helpers/stdinSimulator.js';

chalk.level = 0;

const options: SelectOptionItem<string>[] = [
  { label: 'Architecture', value: 'architecture' },
  { label: 'Testing', value: 'testing' },
  { label: 'Security', value: 'security' },
];

function renderedOutput(): string {
  return vi.mocked(process.stdout.write).mock.calls
    .map(([chunk]) => String(chunk))
    .join('');
}

describe('selectMultipleOptions', () => {
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

  it('should select multiple items with Space and return them only when Enter confirms', async () => {
    const stdin = setupRawStdin([]);
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      const selection = selectMultipleOptions(
        'Select facets',
        options,
        [],
        { instructions: 'Space to toggle, Enter to confirm' },
      );
      let settled = false;
      void selection.then(() => {
        settled = true;
      });

      stdin.send(' ');
      await Promise.resolve();
      expect(settled).toBe(false);

      stdin.send('\x1B[B');
      stdin.send(' ');
      await Promise.resolve();
      expect(settled).toBe(false);

      stdin.send('\r');
      const result = await selection;

      expect(result).toEqual(['architecture', 'testing']);
      expect(renderedOutput()).toContain('[x] Architecture');
      expect(renderedOutput()).toContain('[x] Testing');
      expect(renderedOutput()).toContain('[ ] Security');
      expect(consoleLogSpy).toHaveBeenCalledWith('  (Space to toggle, Enter to confirm)');
    } finally {
      consoleLogSpy.mockRestore();
    }
  });

  it('should process Space and Enter received in one stdin chunk', async () => {
    setupRawStdin([' \r '], { continuous: true });

    const result = await selectMultipleOptions('Select facets', options, []);

    expect(result).toEqual(['architecture']);
  });

  it('should ignore unsupported CSI sequences without canceling the prompt', async () => {
    setupRawStdin(['\x1B[D \r'], { continuous: true });

    const result = await selectMultipleOptions('Select facets', options, []);

    expect(result).toEqual(['architecture']);
  });

  it('should ignore unsupported Alt and string control sequences without canceling the prompt', async () => {
    setupRawStdin([
      '\x1Bx\x1B]0;title\x07\x1BPpayload\x1B\\\x1B^payload\x1B\\\x1B_payload\x1B\\ \r',
    ], { continuous: true });

    const result = await selectMultipleOptions('Select facets', options, []);

    expect(result).toEqual(['architecture']);
  });

  it('should process an arrow sequence split after ESC across stdin events', async () => {
    const stdin = setupRawStdin([]);
    const selection = selectMultipleOptions('Select facets', options, []);

    stdin.send('\x1B');
    await Promise.resolve();
    stdin.send('[B');
    stdin.send(' \r');

    await expect(selection).resolves.toEqual(['testing']);
  });

  it('should process an arrow sequence split after a 30ms delay', async () => {
    vi.useFakeTimers();
    const stdin = setupRawStdin([]);

    try {
      const selection = selectMultipleOptions('Select facets', options, []);
      stdin.send('\x1B');
      vi.advanceTimersByTime(30);
      stdin.send('[B \r');

      await expect(selection).resolves.toEqual(['testing']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('should process an arrow sequence split after the CSI prefix across stdin events', async () => {
    const stdin = setupRawStdin([]);
    const selection = selectMultipleOptions('Select facets', options, []);

    stdin.send('\x1B[');
    stdin.send('B \r');

    await expect(selection).resolves.toEqual(['testing']);
  });

  it('should process SS3 arrows and ignore SS3 function keys in one stdin chunk', async () => {
    setupRawStdin(['\x1BOB\x1BOA\x1BOP \r'], { continuous: true });

    const result = await selectMultipleOptions('Select facets', options, []);

    expect(result).toEqual(['architecture']);
  });

  it('should process SS3 arrows and ignore SS3 function keys split across stdin events', async () => {
    const stdin = setupRawStdin([]);
    const selection = selectMultipleOptions('Select facets', options, []);

    stdin.send('\x1B');
    stdin.send('OB');
    stdin.send('\x1BO');
    stdin.send('P');
    stdin.send(' \r');

    await expect(selection).resolves.toEqual(['testing']);
  });

  it('should process SS3 arrows split after a 30ms delay and ignore F1', async () => {
    vi.useFakeTimers();
    const stdin = setupRawStdin([]);

    try {
      const selection = selectMultipleOptions('Select facets', options, []);
      stdin.send('\x1B');
      vi.advanceTimersByTime(30);
      stdin.send('OB\x1BOP \r');

      await expect(selection).resolves.toEqual(['testing']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('should discard an incomplete CSI after its timeout and process later confirmation input', async () => {
    vi.useFakeTimers();
    const stdin = setupRawStdin([]);

    try {
      const selection = selectMultipleOptions('Select facets', options, []);
      stdin.send('\x1B[1');
      vi.advanceTimersByTime(500);
      stdin.send(' \r');

      await expect(selection).resolves.toEqual(['architecture']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('should cancel after a standalone ESC reaches its timeout', async () => {
    vi.useFakeTimers();
    const stdin = setupRawStdin([]);

    try {
      const selection = selectMultipleOptions('Select facets', options, []);
      stdin.send('\x1B');
      vi.advanceTimersByTime(500);

      await expect(selection).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('should process confirmation input received after an incomplete CSI sequence', async () => {
    const stdin = setupRawStdin([]);
    const selection = selectMultipleOptions('Select facets', options, []);

    stdin.send('\x1B[');
    stdin.send('1\r');

    await expect(selection).resolves.toEqual([]);
  });

  it('should discard an incomplete SS3 sequence after its timeout and process later confirmation input', async () => {
    vi.useFakeTimers();
    const stdin = setupRawStdin([]);

    try {
      const selection = selectMultipleOptions('Select facets', options, []);
      stdin.send('\x1BO');
      vi.advanceTimersByTime(500);
      stdin.send(' \r');

      await expect(selection).resolves.toEqual(['architecture']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('should discard an overlong incomplete CSI and process following input', async () => {
    setupRawStdin([`\x1B[${'1'.repeat(64)} \r`], { continuous: true });

    const result = await selectMultipleOptions('Select facets', options, []);

    expect(result).toEqual(['architecture']);
  });

  it('should reject oversized stdin chunks before decoding or processing keys', async () => {
    setupRawStdin([' '.repeat(64 * 1024 + 1)], { continuous: true });

    await expect(selectMultipleOptions('Select facets', options, [])).rejects
      .toThrow('Interactive selection input exceeds 65536 byte limit');

    expect(process.stdin.setRawMode).toHaveBeenLastCalledWith(false);
    expect(process.stdin.pause).toHaveBeenCalledOnce();
  });

  it('should remove selected items and append new selections without changing the input array', async () => {
    const initial = ['testing', 'security'];
    setupRawStdin([' ', '\x1B[B', ' ', '\r'], { continuous: true });

    const result = await selectMultipleOptions('Select facets', options, initial);

    expect(result).toEqual(['security', 'architecture']);
    expect(initial).toEqual(['testing', 'security']);
  });

  it('should omit unknown and duplicate initial values from the confirmed selection', async () => {
    setupRawStdin(['\r'], { continuous: true });

    const result = await selectMultipleOptions(
      'Select facets',
      options,
      ['architecture', 'unknown', 'architecture'],
    );

    expect(result).toEqual(['architecture']);
  });

  it('should reject options with duplicate values before rendering the prompt', async () => {
    await expect(selectMultipleOptions(
      'Select facets',
      [
        { label: 'Architecture', value: 'architecture' },
        { label: 'Architecture duplicate', value: 'architecture' },
      ],
      [],
    )).rejects.toThrow('Multiple-select options must have unique values: architecture');
  });

  it('should return null when no options are available', async () => {
    const result = await selectMultipleOptions(
      'Select facets',
      [],
      ['architecture'],
    );

    expect(result).toBeNull();
  });

  it('should display the multiple-select instructions when settings are omitted', async () => {
    setupRawStdin(['\x1B'], { continuous: true });
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await selectMultipleOptions('Select facets', options, []);

      expect(consoleLogSpy).toHaveBeenCalledWith('  (↑↓ to move, Space to toggle, Enter to confirm)');
    } finally {
      consoleLogSpy.mockRestore();
    }
  });

  it('should display the multiple-select instructions when instructions are empty', async () => {
    setupRawStdin(['\x1B'], { continuous: true });
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await selectMultipleOptions('Select facets', options, [], { instructions: '' });

      expect(consoleLogSpy).toHaveBeenCalledWith('  (↑↓ to move, Space to toggle, Enter to confirm)');
    } finally {
      consoleLogSpy.mockRestore();
    }
  });

  it('should return an empty array when every selected item is toggled off before Enter', async () => {
    setupRawStdin([' ', '\r'], { continuous: true });

    const result = await selectMultipleOptions('Select facets', options, ['architecture']);

    expect(result).toEqual([]);
  });

  it('should return null when selection is canceled', async () => {
    setupRawStdin(['\x1B'], { continuous: true });

    const result = await selectMultipleOptions('Select facets', options, ['architecture']);

    expect(result).toBeNull();
  });
});
