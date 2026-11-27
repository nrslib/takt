import { renderToString } from 'ink';
import stringWidth from 'string-width';
import { describe, expect, it } from 'vitest';
import { StatusLine } from '../features/tui/StatusLine.js';
import { stripAnsi } from '../shared/utils/text.js';

describe('TUI status line', () => {
  it.each([
    { streamed: 'first\nlast', tail: 'last' },
    { streamed: 'first\nlast\n', tail: 'last' },
    { streamed: '', tail: '' },
  ])('should keep the response tail on the status row for $streamed', ({ streamed, tail }) => {
    const output = stripAnsi(renderToString(<StatusLine busy label="Responding" streamed={streamed} />, { columns: 80 }));
    expect(output.split('\n')).toHaveLength(1);
    expect(output).toContain('Responding');
    if (tail !== '') expect(output).toContain(tail);
    expect(output).not.toContain('first');
  });

  it.each([
    { activity: `${'command '.repeat(100)}END_OF_ACTIVITY`, prefix: 'command' },
    { activity: `${'日本語の長いパス'.repeat(100)}END_OF_ACTIVITY`, prefix: '日本語' },
  ])('should truncate a long activity at the right edge for $prefix', ({ activity, prefix }) => {
    const output = stripAnsi(renderToString(<StatusLine busy label={`0s (Esc: interrupt) ${activity}`} streamed="" />, { columns: 48 }));
    expect(output.split('\n')).toHaveLength(1);
    expect(stringWidth(output)).toBeLessThanOrEqual(48);
    expect(output).toContain('(Esc: interrupt)');
    expect(output).toContain(prefix);
    expect(output).not.toContain('END_OF_ACTIVITY');
  });

  it('should occupy one blank row when the turn is idle', () => {
    const output = stripAnsi(renderToString(<StatusLine busy={false} label="old tool 9s (Esc: interrupt)" streamed="old tail" />, { columns: 80 }));
    expect(output.split('\n')).toHaveLength(1);
    expect(output.trim()).toBe('');
  });
});
