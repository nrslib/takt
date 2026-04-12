/**
 * Tests for completion menu rendering and terminal output
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import chalk from 'chalk';
import {
  renderCompletionMenu,
  writeCompletionMenu,
  clearCompletionMenu,
  type CompletionCandidate,
} from '../features/interactive/completionMenu.js';
import { stripAnsi, getDisplayWidth } from '../shared/utils/text.js';

const ENGLISH_CANDIDATES: readonly CompletionCandidate[] = [
  { value: '/play', description: 'Run a task immediately', applyValue: '/play ' },
  { value: '/go', description: 'Create instruction & run', applyValue: '/go ' },
  { value: '/retry', description: 'Review & rerun with previous instructions', applyValue: '/retry ' },
];

const JAPANESE_CANDIDATES: readonly CompletionCandidate[] = [
  { value: '/play', description: 'タスクを即実行する', applyValue: '/play ' },
];

describe('renderCompletionMenu', () => {
  it('should return separator + one line per candidate', () => {
    const lines = renderCompletionMenu(ENGLISH_CANDIDATES, 0, 80);
    expect(lines.length).toBe(ENGLISH_CANDIDATES.length + 1);
  });

  it('should include command name in each line', () => {
    const lines = renderCompletionMenu(ENGLISH_CANDIDATES, 0, 80);
    const stripped = lines.map(stripAnsi);
    expect(stripped[1]).toContain('/play');
    expect(stripped[2]).toContain('/go');
  });

  it('should include description in each line', () => {
    const lines = renderCompletionMenu([ENGLISH_CANDIDATES[0]!], 0, 80);
    const stripped = lines.map(stripAnsi);
    expect(stripped[1]).toContain('Run a task immediately');
  });

  it('should include Japanese description when provided', () => {
    const lines = renderCompletionMenu(JAPANESE_CANDIDATES, 0, 80);
    const stripped = lines.map(stripAnsi);
    expect(stripped[1]).toContain('タスクを即実行する');
  });

  it('should render separator as first line', () => {
    const lines = renderCompletionMenu(ENGLISH_CANDIDATES, 0, 80);
    const stripped = stripAnsi(lines[0]!);
    expect(stripped).toMatch(/^─+$/);
    expect(stripped.length).toBe(80);
  });

  it('should handle empty candidates', () => {
    const lines = renderCompletionMenu([], 0, 80);
    expect(lines.length).toBe(1);
  });

  it('should handle narrow terminal width', () => {
    const lines = renderCompletionMenu([ENGLISH_CANDIDATES[0]!], 0, 30);
    expect(lines.length).toBe(2);
  });

  it('should always include all candidate commands regardless of selectedIndex', () => {
    const lines0 = renderCompletionMenu(ENGLISH_CANDIDATES, 0, 80).map(stripAnsi);
    const lines2 = renderCompletionMenu(ENGLISH_CANDIDATES, 2, 80).map(stripAnsi);
    expect(lines0[1]).toContain('/play');
    expect(lines2[1]).toContain('/play');
    expect(lines0[3]).toContain('/retry');
    expect(lines2[3]).toContain('/retry');
  });

  it('should omit description when terminal width is very narrow', () => {
    const lines = renderCompletionMenu([ENGLISH_CANDIDATES[0]!], 0, 14);
    const stripped = stripAnsi(lines[1]!);
    expect(stripped).toContain('/play');
    expect(stripped).not.toContain('Run a task');
  });

  it.each([20, 26, 30, 40])('should not exceed termWidth=%i for English candidates', (termWidth) => {
    const lines = renderCompletionMenu(ENGLISH_CANDIDATES, 0, termWidth);
    for (const line of lines) {
      const width = getDisplayWidth(stripAnsi(line));
      expect(width).toBeLessThanOrEqual(termWidth);
    }
  });

  it.each([20, 26, 30, 40])('should not exceed termWidth=%i for Japanese candidates', (termWidth) => {
    const lines = renderCompletionMenu(JAPANESE_CANDIDATES, 0, termWidth);
    for (const line of lines) {
      const width = getDisplayWidth(stripAnsi(line));
      expect(width).toBeLessThanOrEqual(termWidth);
    }
  });

  it('should apply different styles for selected vs unselected candidates', () => {
    const prevLevel = chalk.level;
    chalk.level = 1;
    try {
      const lines0 = renderCompletionMenu(ENGLISH_CANDIDATES, 0, 80);
      const lines1 = renderCompletionMenu(ENGLISH_CANDIDATES, 1, 80);
      expect(lines0[1]).not.toBe(lines1[1]);
      expect(lines0[2]).not.toBe(lines1[2]);
    } finally {
      chalk.level = prevLevel;
    }
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
    expect(output).toContain('separator\nitem1\nitem2');
  });

  it('should move cursor down when rowsBelowCursor > 0', () => {
    writeCompletionMenu(['line'], 3);
    expect(writtenData[0]).toBe('\x1B[3B');
  });

  it('should erase below and restore cursor position', () => {
    writeCompletionMenu(['line'], 0);
    const output = writtenData.join('');
    expect(output).toContain('\x1B[J');
    expect(output).toContain('\x1B[1A');
  });

  it('should restore cursor by total lines when multiple lines written', () => {
    writeCompletionMenu(['sep', 'item1', 'item2', 'item3'], 0);
    const output = writtenData.join('');
    expect(output).toContain('\x1B[4A');
  });

  it('should restore cursor by lines + rowsBelowCursor combined', () => {
    writeCompletionMenu(['sep', 'item1', 'item2'], 2);
    const output = writtenData.join('');
    expect(output).toContain('\x1B[2B');
    expect(output).toContain('\x1B[5A');
  });
});

describe('clearCompletionMenu', () => {
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

  it('should erase below cursor', () => {
    clearCompletionMenu(0);
    const output = writtenData.join('');
    expect(output).toContain('\x1B[J');
  });

  it('should move cursor down when rowsBelowCursor > 0', () => {
    clearCompletionMenu(2);
    expect(writtenData[0]).toBe('\x1B[2B');
  });

  it('should restore cursor after clearing', () => {
    clearCompletionMenu(0);
    const output = writtenData.join('');
    expect(output).toContain('\x1B[1A');
  });

  it('should move up by rowsBelowCursor + 1 when clearing', () => {
    clearCompletionMenu(2);
    const output = writtenData.join('');
    expect(output).toContain('\x1B[3A');
  });
});
