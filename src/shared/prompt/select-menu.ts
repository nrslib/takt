/**
 * Pure functions for select menu rendering and input handling.
 *
 * All functions are side-effect-free and testable in isolation.
 * IO concerns (stdin/stdout, raw mode) remain in select.ts.
 * Viewport logic lives in select-viewport.ts.
 */

import chalk from 'chalk';
import { truncateText } from '../utils/index.js';

export interface SelectOptionItem<T extends string> {
  label: string;
  value: T;
  description?: string;
  details?: string[];
  /**
   * When false the row is a non-interactive heading: the cursor skips it,
   * Enter is ignored, and it renders without a selection marker. Absent or
   * true keeps the row selectable (the default for every existing caller).
   */
  selectable?: boolean;
}

export type KeyInputResult =
  | { action: 'move'; newIndex: number }
  | { action: 'confirm'; selectedIndex: number }
  | { action: 'cancel'; cancelIndex: number }
  | { action: 'bookmark'; selectedIndex: number }
  | { action: 'remove_bookmark'; selectedIndex: number }
  | { action: 'exit' }
  | { action: 'none' };

export interface ViewportState {
  readonly scrollOffset: number;
  readonly maxOptionLines: number;
  readonly active: boolean;
}

// ── Rendering helpers ────────────────────────────────────────────────

const LABEL_PREFIX = 4;
const DESC_PREFIX = 5;
const DETAIL_PREFIX = 9;

export function renderSingleOption<T extends string>(
  opt: SelectOptionItem<T>,
  isSelected: boolean,
  maxWidth: number,
): string[] {
  const lines: string[] = [];
  const truncatedLabel = truncateText(opt.label, maxWidth - LABEL_PREFIX);
  if (opt.selectable === false) {
    // Heading rows never carry the cursor: align their text under the label
    // column and dim them so authored leaves stand out as the selectable rows.
    lines.push(chalk.gray(`    ${truncatedLabel}`));
    if (opt.description) {
      const truncatedDesc = truncateText(opt.description, maxWidth - DESC_PREFIX);
      lines.push(chalk.gray(`     ${truncatedDesc}`));
    }
    return lines;
  }
  const cursor = isSelected ? chalk.cyan('❯') : ' ';
  const label = isSelected ? chalk.cyan.bold(truncatedLabel) : truncatedLabel;
  lines.push(`  ${cursor} ${label}`);

  if (opt.description) {
    const truncatedDesc = truncateText(opt.description, maxWidth - DESC_PREFIX);
    lines.push(chalk.gray(`     ${truncatedDesc}`));
  }
  if (opt.details && opt.details.length > 0) {
    for (const detail of opt.details) {
      const truncatedDetail = truncateText(detail, maxWidth - DETAIL_PREFIX);
      lines.push(chalk.dim(`       • ${truncatedDetail}`));
    }
  }

  return lines;
}

export function renderCancelOption(isSelected: boolean, cancelLabel: string): string {
  const cursor = isSelected ? chalk.cyan('❯') : ' ';
  const label = isSelected ? chalk.cyan.bold(cancelLabel) : chalk.gray(cancelLabel);
  return `  ${cursor} ${label}`;
}

// ── Public pure functions ────────────────────────────────────────────

export function countItemLines<T extends string>(opt: SelectOptionItem<T>): number {
  let lines = 1;
  if (opt.description) lines++;
  if (opt.details) lines += opt.details.length;
  return lines;
}

export function renderMenu<T extends string>(
  options: SelectOptionItem<T>[],
  selectedIndex: number,
  hasCancelOption: boolean,
  cancelLabel = 'Cancel',
): string[] {
  const maxWidth = process.stdout.columns || 80;
  const lines: string[] = [];

  for (let i = 0; i < options.length; i++) {
    const opt = options[i];
    if (!opt) continue;
    const isSelected = i === selectedIndex;
    lines.push(...renderSingleOption(opt, isSelected, maxWidth));
  }

  if (hasCancelOption) {
    const isCancelSelected = selectedIndex === options.length;
    lines.push(renderCancelOption(isCancelSelected, cancelLabel));
  }

  return lines;
}

export function countRenderedLines<T extends string>(
  options: SelectOptionItem<T>[],
  hasCancelOption: boolean,
): number {
  let count = 0;
  for (const opt of options) {
    count += countItemLines(opt);
  }
  if (hasCancelOption) count++;
  return count;
}

/**
 * An option row is non-selectable only when it explicitly declares
 * `selectable: false`. Indices without a backing option (the trailing Cancel
 * row) are always selectable.
 */
function isSelectableIndex<T extends string>(
  index: number,
  options?: readonly SelectOptionItem<T>[],
): boolean {
  return options?.[index]?.selectable !== false;
}

/**
 * Find the first selectable row at or after `start`, scanning forward and
 * wrapping. Returns the Cancel row when no option is selectable and a Cancel
 * row exists, otherwise `start` unchanged.
 */
export function firstSelectableIndex<T extends string>(
  options: readonly SelectOptionItem<T>[],
  start: number,
  hasCancelOption: boolean,
): number {
  const total = options.length;
  if (total === 0) {
    return hasCancelOption ? 0 : start;
  }
  for (let offset = 0; offset < total; offset += 1) {
    const index = (start + offset) % total;
    if (isSelectableIndex(index, options)) {
      return index;
    }
  }
  return hasCancelOption ? total : start;
}

function nextSelectableIndex<T extends string>(
  currentIndex: number,
  step: number,
  totalItems: number,
  options?: readonly SelectOptionItem<T>[],
): number {
  let index = currentIndex;
  for (let visited = 0; visited < totalItems; visited += 1) {
    index = (index + step + totalItems) % totalItems;
    if (index === currentIndex) {
      break;
    }
    if (isSelectableIndex(index, options)) {
      return index;
    }
  }
  return currentIndex;
}

export function handleKeyInput<T extends string>(
  key: string,
  currentIndex: number,
  totalItems: number,
  hasCancelOption: boolean,
  optionCount: number,
  options?: readonly SelectOptionItem<T>[],
): KeyInputResult {
  if (key === '\x1B[A' || key === '\x1BOA' || key === 'k') {
    return { action: 'move', newIndex: nextSelectableIndex(currentIndex, -1, totalItems, options) };
  }
  if (key === '\x1B[B' || key === '\x1BOB' || key === 'j') {
    return { action: 'move', newIndex: nextSelectableIndex(currentIndex, 1, totalItems, options) };
  }
  if (key === '\r' || key === '\n') {
    if (!isSelectableIndex(currentIndex, options)) {
      return { action: 'none' };
    }
    return { action: 'confirm', selectedIndex: currentIndex };
  }
  if (key === '\x03') {
    return { action: 'exit' };
  }
  if (key === '\x1B') {
    return { action: 'cancel', cancelIndex: hasCancelOption ? optionCount : -1 };
  }
  if (key === 'b') {
    return { action: 'bookmark', selectedIndex: currentIndex };
  }
  if (key === 'r') {
    return { action: 'remove_bookmark', selectedIndex: currentIndex };
  }
  return { action: 'none' };
}
