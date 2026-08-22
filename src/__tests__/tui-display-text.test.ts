import { describe, expect, it } from 'vitest';
import { toDisplayText } from '../features/tui/displayText.js';

/** Feed the buffer one chunk at a time, exactly as the streaming sink does. */
function renderProgressively(chunks: readonly string[]): { frames: string[]; final: string } {
  let raw = '';
  const frames: string[] = [];
  for (const chunk of chunks) {
    raw += chunk;
    frames.push(toDisplayText(raw));
  }
  return { frames, final: toDisplayText(raw) };
}

describe('TUI display sanitizer', () => {
  it('should keep plain text and renderable whitespace untouched', () => {
    expect(toDisplayText('hello\nworld\tagain')).toBe('hello\nworld\tagain');
  });

  it('should strip numeric and private-mode CSI sequences', () => {
    expect(toDisplayText('\x1b[31mred\x1b[0m')).toBe('red');
    expect(toDisplayText('\x1b[?25lhidden\x1b[?25h')).toBe('hidden');
    expect(toDisplayText('\x1b[?2026hsync\x1b[?2026l')).toBe('sync');
    expect(toDisplayText('\x1b[1;2;3$rparams')).toBe('params');
  });

  it('should strip the 8-bit C1 introducers', () => {
    expect(toDisplayText('\x9b31mred')).toBe('red');
    expect(toDisplayText('\x9d0;title\x07kept')).toBe('kept');
    expect(toDisplayText('\x9d0;title\x9ckept')).toBe('kept');
  });

  it('should strip OSC sequences with either terminator', () => {
    expect(toDisplayText('\x1b]0;window-title\x07after')).toBe('after');
    expect(toDisplayText('\x1b]52;c;cGF5bG9hZA==\x1b\\after')).toBe('after');
  });

  it('should strip bare control bytes but keep newline and tab', () => {
    expect(toDisplayText('a\rb\x00c\x7fd\x85e\x07f')).toBe('abcdef');
    expect(toDisplayText('a\nb\tc')).toBe('a\nb\tc');
  });

  it('should swallow a C1 string sequence up to its terminator', () => {
    // 0x9e is PM: everything up to the terminator belongs to the sequence.
    expect(toDisplayText('a\x9ehidden\x07b')).toBe('ab');
  });

  it('should withhold a trailing sequence that is still incomplete', () => {
    expect(toDisplayText('ab\x1b')).toBe('ab');
    expect(toDisplayText('ab\x1b[')).toBe('ab');
    expect(toDisplayText('ab\x1b[?25')).toBe('ab');
    expect(toDisplayText('ab\x1b]0;title')).toBe('ab');
    expect(toDisplayText('ab\x1b]0;title\x1b')).toBe('ab');
    expect(toDisplayText('ab\x9b31')).toBe('ab');
  });

  it('should never render a partial CSI split across chunks', () => {
    const { frames, final } = renderProgressively(['red', '\x1b', '[', '3', '1', 'm', 'text']);

    expect(frames.some((frame) => frame.includes('\x1b'))).toBe(false);
    expect(frames.some((frame) => frame.includes('['))).toBe(false);
    expect(final).toBe('redtext');
  });

  it('should never render a partial OSC split across chunks', () => {
    const { frames, final } = renderProgressively(['start', '\x1b]52;c;', 'cGF5bG9h', 'ZA==', '\x1b', '\\', 'end']);

    expect(frames.every((frame) => !frame.includes('cGF5bG9h'))).toBe(true);
    expect(frames.some((frame) => frame.includes('\x1b'))).toBe(false);
    expect(final).toBe('startend');
  });

  it('should not swallow a renderable byte that cannot complete an ESC sequence', () => {
    expect(toDisplayText('a\x1b\nb')).toBe('a\nb');
    expect(toDisplayText('a\x1b\tb')).toBe('a\tb');
    expect(toDisplayText('a\x1b\rb')).toBe('ab');
    expect(toDisplayText('a\x1b\x1b[31mb')).toBe('ab');
  });

  it('should resume after a malformed CSI instead of dropping the rest', () => {
    expect(toDisplayText('a\x1b[31\nb')).toBe('a\nb');
  });

});
