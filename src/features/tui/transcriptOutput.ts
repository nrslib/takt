import chalk from 'chalk';
import type { TranscriptEntry } from './TranscriptEntryView.js';
import { toDisplayText } from './displayText.js';
import type { UserMessageColors } from './terminalColors.js';

export const USER_MARKER = '❯ ';
export const ASSISTANT_MARKER = '● ';
export const MARKER_WIDTH = 2;

const INDENT = ' '.repeat(MARKER_WIDTH);
const CLEAR_TO_LINE_END = '\x1b[K';

/**
 * Commit paragraphs without width-dependent newlines or space padding. Native
 * soft wraps can then expand again without clearing/replaying terminal history.
 * Only the source's explicit newlines remain hard breaks. Wrapped rows start at
 * the terminal's left edge; explicit continuation lines keep the marker indent.
 */
export function formatTranscriptEntryOutput(entry: TranscriptEntry, colors: UserMessageColors): string {
  const lines = toDisplayText(entry.content).split('\n');
  if (entry.role === 'system') {
    return `${chalk.gray(lines.map((line) => `${INDENT}${line}`).join('\n'))}\n\n`;
  }
  if (entry.role === 'assistant') {
    const first = `${chalk.white(ASSISTANT_MARKER)}${lines[0] ?? ''}`;
    return `${[first, ...lines.slice(1).map((line) => `${INDENT}${line}`)].join('\n')}\n\n`;
  }

  const text = [`${USER_MARKER}${lines[0] ?? ''}`, ...lines.slice(1).map((line) => `${INDENT}${line}`)]
    .join(`\n${CLEAR_TO_LINE_END}`);
  const foreground = colors.foreground === undefined ? text : chalk.hex(colors.foreground)(text);
  // Paint BEFORE text: erase-to-end after a full-width line can erase its last
  // glyph when the terminal clamps a pending-wrap cursor to the right margin.
  // Literal width-padding spaces would become gaps when native wraps merge.
  const band = chalk.bgHex(colors.background)(
    `${CLEAR_TO_LINE_END}\n${CLEAR_TO_LINE_END}${foreground}\n${CLEAR_TO_LINE_END}`,
  );
  return `${band}\n\n`;
}
