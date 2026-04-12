/**
 * Inline completion menu renderer.
 *
 * Provides pure rendering functions and terminal drawing helpers
 * for the slash command autocomplete menu displayed below the input line.
 */

import chalk from 'chalk';
import { getDisplayWidth, truncateText } from '../../shared/utils/text.js';

const SEPARATOR_CHAR = '─';
const LEFT_PADDING = 2;
const DESC_GAP = 2;
const MIN_COMMAND_WIDTH = 8;

/**
 * A single completion candidate entry.
 */
export type CompletionCandidate = {
  readonly value: string;
  readonly description?: string;
  readonly applyValue?: string;
};

/**
 * Render completion menu lines (pure function).
 *
 * Returns an array of styled strings: separator line + one line per candidate.
 */
export const renderCompletionMenu = (
  candidates: readonly CompletionCandidate[],
  selectedIndex: number,
  termWidth: number,
): readonly string[] => {
  const separator = chalk.dim(SEPARATOR_CHAR.repeat(termWidth));

  const maxCommandDisplayWidth = candidates.reduce(
    (max, entry) => Math.max(max, getDisplayWidth(entry.value)),
    0,
  );
  const commandColWidth = Math.max(maxCommandDisplayWidth + 2, MIN_COMMAND_WIDTH);
  const availableForRow = Math.max(termWidth - LEFT_PADDING, 0);
  const clampedCommandCol = Math.min(commandColWidth, availableForRow);
  const descMaxWidth = availableForRow - clampedCommandCol - DESC_GAP;

  const lines = candidates.map((entry, i) => {
    const isSelected = i === selectedIndex;
    const commandText = getDisplayWidth(entry.value) > clampedCommandCol
      ? truncateText(entry.value, clampedCommandCol)
      : entry.value;
    const command = commandText.padEnd(clampedCommandCol);
    const desc = descMaxWidth > 0
      ? truncateText(entry.description ?? '', descMaxWidth)
      : '';

    if (isSelected) return `${' '.repeat(LEFT_PADDING)}${chalk.cyan.bold(command)}${chalk.gray(desc)}`;
    return `${' '.repeat(LEFT_PADDING)}${chalk.gray(command)}${chalk.dim(desc)}`;
  });

  return [separator, ...lines];
};

/**
 * Write the completion menu below the current cursor position.
 *
 * Moves cursor down to below the input, draws the menu,
 * then restores cursor to original position.
 */
export const writeCompletionMenu = (
  lines: readonly string[],
  rowsBelowCursor: number,
): void => {
  if (rowsBelowCursor > 0) {
    process.stdout.write(`\x1B[${rowsBelowCursor}B`);
  }
  process.stdout.write('\r\n');
  process.stdout.write('\x1B[J');
  process.stdout.write(lines.join('\n'));

  const moveUp = lines.length + rowsBelowCursor;
  if (moveUp > 0) {
    process.stdout.write(`\x1B[${moveUp}A`);
  }
};

/**
 * Clear the completion menu from the terminal.
 *
 * Moves cursor below input, erases everything, then restores position.
 */
export const clearCompletionMenu = (
  rowsBelowCursor: number,
): void => {
  if (rowsBelowCursor > 0) {
    process.stdout.write(`\x1B[${rowsBelowCursor}B`);
  }
  process.stdout.write('\r\n');
  process.stdout.write('\x1B[J');

  const moveUp = 1 + rowsBelowCursor;
  if (moveUp > 0) {
    process.stdout.write(`\x1B[${moveUp}A`);
  }
};
