/**
 * Inline completion menu renderer for slash commands.
 *
 * Provides pure rendering functions and terminal drawing helpers
 * for the slash command autocomplete menu displayed below the input line.
 */

import chalk from 'chalk';
import { truncateText } from '../../shared/utils/text.js';
import type { SlashCommandEntry } from './slashCommandRegistry.js';

/** State of the visible completion menu */
export interface CompletionState {
  readonly candidates: readonly SlashCommandEntry[];
  selectedIndex: number;
}

const SEPARATOR_CHAR = '─';
const COMMAND_COLUMN_WIDTH = 24;
const LEFT_PADDING = 2;

/**
 * Render completion menu lines (pure function).
 *
 * Returns an array of styled strings: separator line + one line per candidate.
 */
export const renderCompletionMenu = (
  candidates: readonly SlashCommandEntry[],
  selectedIndex: number,
  termWidth: number,
  lang: 'en' | 'ja',
): readonly string[] => {
  const separator = chalk.dim(SEPARATOR_CHAR.repeat(termWidth));
  const descMaxWidth = termWidth - LEFT_PADDING - COMMAND_COLUMN_WIDTH - 2;

  const lines = candidates.map((entry, i) => {
    const isSelected = i === selectedIndex;
    const command = entry.command.padEnd(COMMAND_COLUMN_WIDTH);
    const desc = descMaxWidth > 0
      ? truncateText(entry.description[lang], descMaxWidth)
      : '';

    if (isSelected) {
      return `${' '.repeat(LEFT_PADDING)}${chalk.cyan.bold(command)}${chalk.gray(desc)}`;
    }
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
