import chalk from 'chalk';
import { describe, expect, it } from 'vitest';
import type { TranscriptEntry } from '../features/tui/TranscriptEntryView.js';
import { formatTranscriptEntryOutput } from '../features/tui/transcriptOutput.js';
import { toDisplayText } from '../features/tui/displayText.js';
import { FALLBACK_USER_MESSAGE_COLORS } from '../features/tui/terminalColors.js';

/** Forces true-color output for an assertion and restores Chalk even on failure. */
function withColors(test: () => void): void {
  const level = chalk.level;
  chalk.level = 3;
  try {
    test();
  } finally {
    chalk.level = level;
  }
}

describe('formatTranscriptEntryOutput', () => {
  it.each(['user', 'assistant', 'system'] as const)('should not hard-wrap a long %s paragraph', (role) => {
    const content = 'a long paragraph with spaces 日本語 '.repeat(100);
    const output = formatTranscriptEntryOutput({ role, content }, FALLBACK_USER_MESSAGE_COLORS);
    expect(toDisplayText(output)).toContain(content);
    expect(output).not.toMatch(/\x1b\[(?:2|3)J/);
  });

  it.each([
    { role: 'user', expected: '\n❯ first\n  second\n\n\n' },
    { role: 'assistant', expected: '● first\n  second\n\n' },
    { role: 'system', expected: '  first\n  second\n\n' },
  ] as const)('should preserve explicit source line breaks for $role', ({ role, expected }) => {
    const output = formatTranscriptEntryOutput({ role, content: 'first\nsecond' }, FALLBACK_USER_MESSAGE_COLORS);
    expect(toDisplayText(output)).toBe(expected);
  });

  it.each(['user', 'assistant', 'system'] as const)('should sanitize controls before emitting native %s output', (role) => {
    const entry: TranscriptEntry = {
      role,
      content: 'first\x1b[3Jsecond\n\x1b]0;untrusted title\x07tail\x9b?25ldone\r',
    };
    const output = formatTranscriptEntryOutput(entry, FALLBACK_USER_MESSAGE_COLORS);
    expect(toDisplayText(output)).toContain('firstsecond\n  taildone');
    expect(output).not.toContain('untrusted title');
    expect(output).not.toMatch(/\x1b\[3J|\x1b\]|\x9b|\r/);
  });

  it('should paint the user band without inserting width-dependent spaces', () => {
    withColors(() => {
      const output = formatTranscriptEntryOutput({ role: 'user', content: 'hello' }, FALLBACK_USER_MESSAGE_COLORS);
      expect(output).toContain('\x1b[48;2;66;69;75m');
      expect(output).toContain('\x1b[38;2;255;255;255m');
      expect(output.split('\x1b[K')).toHaveLength(4);
      expect(toDisplayText(output)).toBe('\n❯ hello\n\n\n');
    });
  });

  it('should keep the terminal-default foreground when the resolved colors omit it', () => {
    withColors(() => {
      const output = formatTranscriptEntryOutput({ role: 'user', content: 'hello' }, { background: '#d7d7d7' });
      expect(output).toContain('\x1b[48;2;215;215;215m');
      expect(output).not.toMatch(/\x1b\[(?:38;|39m)/);
    });
  });
});
