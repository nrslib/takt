/**
 * Tests for viewport scrolling in select menu.
 *
 * Covers: countItemLines, createViewportState, adjustScrollOffset,
 * renderMenuWithViewport.
 */

import { describe, it, expect } from 'vitest';
import chalk from 'chalk';
import type { SelectOptionItem } from '../shared/prompt/select-menu.js';
import { countItemLines } from '../shared/prompt/select-menu.js';
import {
  createViewportState,
  adjustScrollOffset,
  renderMenuWithViewport,
} from '../shared/prompt/select-viewport.js';

chalk.level = 0;

// ── Test fixtures ────────────────────────────────────────────────────

function labelOnly(label: string, value: string): SelectOptionItem<string> {
  return { label, value };
}

function withDescription(label: string, value: string, description: string): SelectOptionItem<string> {
  return { label, value, description };
}

function withDetails(label: string, value: string, details: string[]): SelectOptionItem<string> {
  return { label, value, details };
}

function withDescAndDetails(
  label: string,
  value: string,
  description: string,
  details: string[],
): SelectOptionItem<string> {
  return { label, value, description, details };
}

// ── countItemLines ───────────────────────────────────────────────────

describe('countItemLines', () => {
  it('should return 1 for label-only option', () => {
    expect(countItemLines(labelOnly('A', 'a'))).toBe(1);
  });

  it('should return 2 when option has description', () => {
    expect(countItemLines(withDescription('A', 'a', 'desc'))).toBe(2);
  });

  it('should count details lines', () => {
    expect(countItemLines(withDetails('A', 'a', ['d1', 'd2']))).toBe(3);
  });

  it('should count description + details', () => {
    expect(countItemLines(withDescAndDetails('A', 'a', 'desc', ['d1', 'd2', 'd3']))).toBe(5);
  });
});

// ── createViewportState ──────────────────────────────────────────────

describe('createViewportState', () => {
  it('should be inactive when all items fit', () => {
    // 3 label-only options = 3 lines, terminal 20 rows, available = 16
    const options = [labelOnly('A', 'a'), labelOnly('B', 'b'), labelOnly('C', 'c')];
    const state = createViewportState(20, options, false);

    expect(state.active).toBe(false);
    expect(state.scrollOffset).toBe(0);
  });

  it('should be inactive when items + cancel fit', () => {
    const options = [labelOnly('A', 'a'), labelOnly('B', 'b')];
    // 2 options + 1 cancel = 3 lines, available = 16
    const state = createViewportState(20, options, true);

    expect(state.active).toBe(false);
  });

  it('should be active when items exceed available lines', () => {
    // 10 label-only options = 10 lines, terminal 10 rows, available = 6
    const options = Array.from({ length: 10 }, (_, i) => labelOnly(`Opt${i}`, `v${i}`));
    const state = createViewportState(10, options, false);

    expect(state.active).toBe(true);
    expect(state.maxOptionLines).toBe(6);
    expect(state.scrollOffset).toBe(0);
  });

  it('should ensure maxOptionLines is at least 1', () => {
    // terminal 5 rows: available = 1
    const options = Array.from({ length: 10 }, (_, i) => labelOnly(`Opt${i}`, `v${i}`));
    const state = createViewportState(5, options, false);

    expect(state.active).toBe(true);
    expect(state.maxOptionLines).toBe(1);
  });

  it('should account for multi-line options', () => {
    // Each option = 2 lines (label + description) → total 6 lines
    // Terminal 8 rows: available = 4, total 6 > 4 → active
    const options = [
      withDescription('A', 'a', 'desc a'),
      withDescription('B', 'b', 'desc b'),
      withDescription('C', 'c', 'desc c'),
    ];
    const state = createViewportState(8, options, false);

    expect(state.active).toBe(true);
    expect(state.maxOptionLines).toBe(4);
  });
});

// ── adjustScrollOffset ───────────────────────────────────────────────

describe('adjustScrollOffset', () => {
  // 10 label-only options, maxOptionLines = 4 → 4 visible at a time
  const options = Array.from({ length: 10 }, (_, i) => labelOnly(`Opt${i}`, `v${i}`));
  const maxLines = 4;
  const noCancel = false;

  it('should not change when selected item is within visible range', () => {
    // scrollOffset=0, visible=[0,1,2,3], selected=2
    const result = adjustScrollOffset(2, 0, options, noCancel, maxLines);
    expect(result).toBe(0);
  });

  it('should scroll down when selected item is below visible range', () => {
    // scrollOffset=0, visible=[0,1,2,3], selected=5
    const result = adjustScrollOffset(5, 0, options, noCancel, maxLines);
    expect(result).toBeGreaterThan(0);
    // Verify the selected item is now visible
    const endCheck = adjustScrollOffset(5, result, options, noCancel, maxLines);
    expect(endCheck).toBe(result);
  });

  it('should scroll up when selected item is above visible range', () => {
    // scrollOffset=5, selected=2
    const result = adjustScrollOffset(2, 5, options, noCancel, maxLines);
    expect(result).toBe(2);
  });

  it('should handle wrap-around from last to first', () => {
    // scrollOffset=6, selected=0 (wrapped from bottom to top)
    const result = adjustScrollOffset(0, 6, options, noCancel, maxLines);
    expect(result).toBe(0);
  });

  it('should handle wrap-around from first to last', () => {
    // scrollOffset=0, selected=9 (wrapped from top to bottom)
    const result = adjustScrollOffset(9, 0, options, noCancel, maxLines);
    expect(result).toBeGreaterThan(0);
  });

  it('should work with cancel option', () => {
    // 3 options + cancel = 4 items, maxOptionLines = 2
    const opts = [labelOnly('A', 'a'), labelOnly('B', 'b'), labelOnly('C', 'c')];
    // Select cancel (index 3), scrollOffset=0
    const result = adjustScrollOffset(3, 0, opts, true, 2);
    expect(result).toBeGreaterThan(0);
  });

  it('should work with multi-line options', () => {
    const multiLineOpts = [
      withDescription('A', 'a', 'desc a'),
      withDescription('B', 'b', 'desc b'),
      withDescription('C', 'c', 'desc c'),
      withDescription('D', 'd', 'desc d'),
    ];
    // maxOptionLines = 4, each item = 2 lines → 2 items visible
    // scrollOffset=0, selected=3 (below visible)
    const result = adjustScrollOffset(3, 0, multiLineOpts, false, 4);
    expect(result).toBeGreaterThan(0);
  });
});

// ── renderMenuWithViewport ───────────────────────────────────────────

describe('renderMenuWithViewport', () => {
  it('should show lower indicator at top of list', () => {
    const options = Array.from({ length: 10 }, (_, i) => labelOnly(`Opt${i}`, `v${i}`));
    // scrollOffset=0, maxOptionLines=3
    const lines = renderMenuWithViewport(options, 0, false, 0, 3, 'Cancel');

    // Last line: lower indicator
    const lastLine = lines[lines.length - 1]!;
    expect(lastLine).toContain('↓');
    expect(lastLine).toContain('more');
  });

  it('should show upper indicator when scrolled down', () => {
    const options = Array.from({ length: 10 }, (_, i) => labelOnly(`Opt${i}`, `v${i}`));
    // scrollOffset=3, maxOptionLines=3
    const lines = renderMenuWithViewport(options, 3, false, 3, 3, 'Cancel');

    // First line: upper indicator
    expect(lines[0]).toContain('↑');
    expect(lines[0]).toContain('3 more');
  });

  it('should show both indicators in the middle', () => {
    const options = Array.from({ length: 10 }, (_, i) => labelOnly(`Opt${i}`, `v${i}`));
    // scrollOffset=3, maxOptionLines=3, one option fits between indicators
    const lines = renderMenuWithViewport(options, 4, false, 3, 3, 'Cancel');

    expect(lines[0]).toContain('↑');
    expect(lines[0]).toContain('3 more');
    const lastLine = lines[lines.length - 1]!;
    expect(lastLine).toContain('↓');
    expect(lastLine).toContain('6 more');
  });

  it('should show both indicators in constrained viewport', () => {
    const options = Array.from({ length: 5 }, (_, i) => labelOnly(`Opt${i}`, `v${i}`));
    // scrollOffset=2, maxOptionLines=3, one option fits between indicators
    const lines = renderMenuWithViewport(options, 4, false, 2, 3, 'Cancel');

    expect(lines[0]).toContain('↑');
    expect(lines[0]).toContain('2 more');
    const lastLine = lines[lines.length - 1]!;
    expect(lastLine).toContain('↓');
    expect(lastLine).toContain('2 more');
  });

  it('should show no lower indicator at end of list', () => {
    const options = Array.from({ length: 5 }, (_, i) => labelOnly(`Opt${i}`, `v${i}`));
    // scrollOffset=3, maxOptionLines=4 → items 3,4 visible, ↑ above, nothing below
    const lines = renderMenuWithViewport(options, 4, false, 3, 4, 'Cancel');

    expect(lines[0]).toContain('↑');
    expect(lines[0]).toContain('3 more');
    const lastLine = lines[lines.length - 1]!;
    expect(lastLine).not.toContain('↓');
  });

  it('should render cancel option when visible', () => {
    const options = [labelOnly('A', 'a'), labelOnly('B', 'b')];
    // 2 options + cancel, maxOptionLines=3, all visible from offset 0
    const lines = renderMenuWithViewport(options, 2, true, 0, 3, 'Cancel');

    const joinedLines = lines.join('\n');
    expect(joinedLines).toContain('Cancel');
  });

  it('should display correct hidden count with cancel option', () => {
    const options = Array.from({ length: 5 }, (_, i) => labelOnly(`Opt${i}`, `v${i}`));
    // 5 options + cancel = 6 items, scrollOffset=0, maxOptionLines=3, two items visible
    const lines = renderMenuWithViewport(options, 0, true, 0, 3, 'Cancel');

    const lastLine = lines[lines.length - 1]!;
    expect(lastLine).toContain('↓');
    expect(lastLine).toContain('4 more');
  });

  it('should render selected item cursor correctly', () => {
    const options = [labelOnly('A', 'a'), labelOnly('B', 'b'), labelOnly('C', 'c')];
    const lines = renderMenuWithViewport(options, 1, false, 0, 3, 'Cancel');

    // Find the line with the cursor
    const cursorLine = lines.find((l) => l.includes('❯'));
    expect(cursorLine).toBeDefined();
    expect(cursorLine).toContain('B');
  });

  it('should handle multi-line options within viewport', () => {
    const options = [
      withDescription('A', 'a', 'desc a'),
      withDescription('B', 'b', 'desc b'),
      withDescription('C', 'c', 'desc c'),
    ];
    // maxOptionLines=4, each item=2 lines → one item plus lower indicator
    const lines = renderMenuWithViewport(options, 0, false, 0, 4, 'Cancel');

    expect(lines.join('\n')).toContain('A');
    expect(lines.join('\n')).toContain('desc a');
    expect(lines.join('\n')).toContain('↓ 2 more');
  });
});
