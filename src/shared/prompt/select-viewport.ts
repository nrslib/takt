/**
 * Pure functions for viewport-based select menu scrolling.
 *
 * Handles scroll offset calculation and viewport-limited rendering.
 */

import chalk from 'chalk';
import type { SelectOptionItem, ViewportState } from './select-menu.js';
import { countItemLines, countRenderedLines, renderSingleOption, renderCancelOption } from './select-menu.js';

const HEADER_LINES = 4;

/**
 * Create viewport state from terminal dimensions and menu content.
 *
 * When all items fit within the available terminal space, viewport is
 * inactive and the menu renders without scrolling (identical to the
 * pre-viewport behaviour).
 */
export function createViewportState<T extends string>(
  terminalRows: number,
  options: SelectOptionItem<T>[],
  hasCancelOption: boolean,
): ViewportState {
  const totalMenuLines = countRenderedLines(options, hasCancelOption);
  const availableLines = Math.max(1, terminalRows - HEADER_LINES);

  if (totalMenuLines <= availableLines) {
    return { scrollOffset: 0, maxOptionLines: availableLines, active: false };
  }

  return {
    scrollOffset: 0,
    maxOptionLines: Math.max(1, availableLines),
    active: true,
  };
}

function getIndicatorLineCount(hasHiddenAbove: boolean, hasHiddenBelow: boolean): number {
  let count = 0;
  if (hasHiddenAbove) count++;
  if (hasHiddenBelow) count++;
  return count;
}

function calculateVisibleRange<T extends string>(
  options: SelectOptionItem<T>[],
  hasCancelOption: boolean,
  scrollOffset: number,
  availableLines: number,
): { endIndex: number; hiddenBelow: number } {
  const totalItems = hasCancelOption ? options.length + 1 : options.length;
  const hasHiddenAbove = scrollOffset > 0;
  let usedLines = 0;
  let count = 0;

  for (let i = scrollOffset; i < totalItems; i++) {
    const itemLines = i < options.length ? countItemLines(options[i]!) : 1;
    const remainingItems = totalItems - (i + 1);
    const hasHiddenBelow = remainingItems > 0;
    const nextUsedLines = usedLines + itemLines;
    const indicatorLines = getIndicatorLineCount(hasHiddenAbove, hasHiddenBelow);

    if (nextUsedLines + indicatorLines > availableLines) {
      break;
    }

    usedLines = nextUsedLines;
    count++;
  }

  if (count === 0 && scrollOffset < totalItems) {
    return {
      endIndex: scrollOffset + 1,
      hiddenBelow: totalItems - (scrollOffset + 1),
    };
  }

  const endIndex = scrollOffset + count;
  return {
    endIndex,
    hiddenBelow: totalItems - endIndex,
  };
}

/**
 * Calculate the exclusive end index of items visible from scrollOffset,
 * fitting within maxOptionLines.
 *
 * `totalItems` is options.length + (hasCancelOption ? 1 : 0).
 */
function calculateVisibleEndIndex<T extends string>(
  options: SelectOptionItem<T>[],
  hasCancelOption: boolean,
  scrollOffset: number,
  maxOptionLines: number,
): number {
  return calculateVisibleRange(options, hasCancelOption, scrollOffset, maxOptionLines).endIndex;
}

/**
 * Adjust scrollOffset so that selectedIndex is visible within the viewport.
 *
 * Returns the new scrollOffset value.
 */
export function adjustScrollOffset<T extends string>(
  selectedIndex: number,
  scrollOffset: number,
  options: SelectOptionItem<T>[],
  hasCancelOption: boolean,
  maxOptionLines: number,
): number {
  if (selectedIndex < scrollOffset) {
    return selectedIndex;
  }

  const endIndex = calculateVisibleEndIndex(options, hasCancelOption, scrollOffset, maxOptionLines);
  if (selectedIndex < endIndex) {
    return scrollOffset;
  }

  let newOffset = selectedIndex;
  while (newOffset > 0) {
    const testEnd = calculateVisibleEndIndex(options, hasCancelOption, newOffset - 1, maxOptionLines);
    if (testEnd <= selectedIndex) break;
    newOffset--;
  }

  return newOffset;
}

/**
 * Render the visible portion of the menu with viewport scrolling.
 *
 * Returns rendered lines including hidden-item indicators.
 */
export function renderMenuWithViewport<T extends string>(
  options: SelectOptionItem<T>[],
  selectedIndex: number,
  hasCancelOption: boolean,
  scrollOffset: number,
  maxOptionLines: number,
  cancelLabel: string,
): string[] {
  const maxWidth = process.stdout.columns || 80;
  const { endIndex, hiddenBelow } = calculateVisibleRange(options, hasCancelOption, scrollOffset, maxOptionLines);
  const lines: string[] = [];

  if (scrollOffset > 0) {
    lines.push(chalk.gray(`  ↑ ${scrollOffset} more`));
  }

  for (let i = scrollOffset; i < endIndex; i++) {
    if (i < options.length) {
      const opt = options[i]!;
      const isSelected = i === selectedIndex;
      lines.push(...renderSingleOption(opt, isSelected, maxWidth));
    } else {
      const isCancelSelected = selectedIndex === options.length;
      lines.push(renderCancelOption(isCancelSelected, cancelLabel));
    }
  }

  if (hiddenBelow > 0) {
    lines.push(chalk.gray(`  ↓ ${hiddenBelow} more`));
  }

  return lines;
}
