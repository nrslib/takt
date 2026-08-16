/**
 * Tests for completion menu rendering and terminal output
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  renderCompletionMenu,
  writeCompletionMenu,
  type CompletionCandidate,
} from '../features/interactive/completionMenu.js';
import { stripAnsi } from '../shared/utils/text.js';

const ENGLISH_CANDIDATES: readonly CompletionCandidate[] = [
  { value: '/play', description: 'Run a task immediately', applyValue: '/play ' },
  { value: '/go', description: 'Create instruction & run', applyValue: '/go ' },
  { value: '/retry', description: 'Review & rerun with previous instructions', applyValue: '/retry ' },
];

describe('renderCompletionMenu', () => {
  it('should return separator + one line per candidate', () => {
    const lines = renderCompletionMenu(ENGLISH_CANDIDATES, 0, 80);
    expect(lines.length).toBe(ENGLISH_CANDIDATES.length + 1);
  });

  it('should preserve each candidate value in the rendered lines', () => {
    const lines = renderCompletionMenu(ENGLISH_CANDIDATES, 0, 80);
    const stripped = lines.map(stripAnsi);
    for (const [index, candidate] of ENGLISH_CANDIDATES.entries()) {
      expect(stripped[index + 1]).toContain(candidate.value);
    }
  });

  it('should handle empty candidates', () => {
    const lines = renderCompletionMenu([], 0, 80);
    expect(lines.length).toBe(1);
  });

});

// --- writeCompletionMenu / clearCompletionMenu terminal output tests ---

describe('writeCompletionMenu', () => {
  let savedWrite: typeof process.stdout.write;
  let writtenData: string[];

  beforeEach(() => {
    savedWrite = process.stdout.write;
    writtenData = [];
    process.stdout.write = vi.fn((data: string | Uint8Array) => {
      writtenData.push(typeof data === 'string' ? data : data.toString());
      return true;
    }) as unknown as typeof process.stdout.write;
  });

  afterEach(() => {
    process.stdout.write = savedWrite;
  });

  it('should write menu lines to stdout', () => {
    const lines = ['separator', 'item1', 'item2'];
    writeCompletionMenu(lines, 0);
    const output = writtenData.join('');
    expect(output).toContain(lines.join('\n'));
  });
});
