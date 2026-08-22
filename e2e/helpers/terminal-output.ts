/**
 * The sanitized view of everything a PTY has emitted so far.
 *
 * A PTY hands over whatever bytes were ready, and those boundaries have nothing
 * to do with escape-sequence boundaries: `\x1b[` can arrive in one chunk and
 * `2K` in the next. Sanitizing each chunk on its own would leave both halves
 * behind, and the leftover control bytes would sit in the middle of the text
 * the assertions search. So the raw bytes are kept as they arrive and the
 * sanitized form is derived from the whole of them.
 *
 * The result is cached: polling for a pattern reads this far more often than
 * the process writes, and a read that follows no new bytes costs nothing.
 */

import { stripAnsi } from '../../src/shared/utils/text.js';

export interface TerminalOutput {
  /** Record bytes exactly as the terminal delivered them. */
  push(chunk: string): void;
  /** Everything received so far, with ANSI sequences removed. */
  text(): string;
}

export function createTerminalOutput(): TerminalOutput {
  let raw = '';
  let sanitized = '';
  /** Length of `raw` that `sanitized` was derived from; -1 before the first read. */
  let sanitizedLength = -1;

  return {
    push(chunk: string): void {
      raw += chunk;
    },

    text(): string {
      if (sanitizedLength !== raw.length) {
        sanitized = stripAnsi(raw);
        sanitizedLength = raw.length;
      }
      return sanitized;
    },
  };
}
