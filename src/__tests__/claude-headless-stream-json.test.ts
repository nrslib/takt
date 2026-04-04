import { describe, expect, it } from 'vitest';

import {
  aggregateContentFromStdout,
  tryExtractTextFromStreamJsonLine,
} from '../infra/claude-headless/stream-json-lines.js';

describe('claude-headless stream-json line parsing (single path for streaming vs aggregate)', () => {
  it('extracts text from a stream-json text line', () => {
    const line = JSON.stringify({ type: 'text', text: 'hello' });
    expect(tryExtractTextFromStreamJsonLine(line)).toBe('hello');
  });

  it('returns undefined for invalid JSON (noise lines)', () => {
    expect(tryExtractTextFromStreamJsonLine('not json')).toBeUndefined();
  });

  it('aggregateContentFromStdout matches concatenation of per-line extraction', () => {
    const stdout = [
      JSON.stringify({ type: 'text', text: 'a' }),
      'garbage',
      JSON.stringify({ type: 'text', text: 'b' }),
    ].join('\n');
    expect(aggregateContentFromStdout(stdout)).toBe('ab');
  });
});
