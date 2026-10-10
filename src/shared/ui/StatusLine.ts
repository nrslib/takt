/**
 * Persistent status line spinner.
 *
 * Shows an animated spinner on the last line of the terminal.
 * Regular output scrolls above it. Intercepts both stdout and stderr
 * writes to clear and redraw the spinner around each write.
 */

import chalk from 'chalk';
import { fstatSync } from 'node:fs';
import { stripVTControlCharacters } from 'node:util';
import { measureWidth, segmentGraphemes } from '../utils/grapheme.js';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

type RawWrite = (str: string) => boolean;

interface StatusLineOptions {
  readonly renderImmediately?: boolean;
  readonly dim?: boolean;
  readonly intervalMs?: number;
  readonly truncate?: boolean;
}

function truncateLine(text: string, columns: number): string {
  if (measureWidth(text) <= columns) return text;
  if (columns <= 0) return '';
  let result = '';
  let width = 0;
  for (const grapheme of segmentGraphemes(text)) {
    const nextWidth = width + measureWidth(grapheme);
    if (nextWidth > columns - 1) break;
    result += grapheme;
    width = nextWidth;
  }
  return `${result}…`;
}

/** Terminal housekeeping is not body text and must not silence progress feedback. */
function hasVisibleContent(text: string): boolean {
  return stripVTControlCharacters(text).replace(/\p{Cc}/gu, '').length > 0;
}

/**
 * TTY flags alone cannot establish that two streams have the same destination.
 * Terminal identity is a display concern, not a reason to abort the user's task.
 */
function sharesOutputTerminal(stdoutFd: number, stderrFd: number): boolean {
  try {
    const stdoutStats = fstatSync(stdoutFd);
    const stderrStats = fstatSync(stderrFd);
    return stdoutStats.dev === stderrStats.dev
      && stdoutStats.ino === stderrStats.ino
      && stdoutStats.rdev === stderrStats.rdev;
  } catch {
    return false;
  }
}

class StatusLineImpl {
  private active = false;
  private message = '';
  private frame = 0;
  private intervalId?: ReturnType<typeof setInterval>;
  private rawStdoutWrite?: RawWrite;
  private savedStdoutWrite?: typeof process.stdout.write;
  private savedStderrWrite?: typeof process.stderr.write;
  private rendering = false;
  private spinnerRendered = false;
  private outputLineOpen = false;
  private options: StatusLineOptions = {};
  private suspendedStatus?: { message: string; options: StatusLineOptions };
  private suspendDepth = 0;

  /** Progress feedback must not corrupt streamed text or leak into redirected output. */
  start(message: string, options: StatusLineOptions = {}): void {
    if (this.suspendDepth > 0) {
      this.suspendedStatus = { message, options };
      return;
    }
    if (this.active) {
      this.message = message;
      return;
    }
    if (!process.stdout.isTTY) return;

    const stderrSharesOutputTerminal = process.stderr.isTTY === true
      && sharesOutputTerminal(process.stdout.fd, process.stderr.fd);

    this.active = true;
    this.message = message;
    this.options = options;
    this.frame = 0;
    this.outputLineOpen = false;

    this.savedStdoutWrite = process.stdout.write;
    this.savedStderrWrite = process.stderr.write;
    this.rawStdoutWrite = process.stdout.write.bind(process.stdout) as RawWrite;
    const rawStderrWrite = process.stderr.write.bind(process.stderr) as RawWrite;
    const raw = this.rawStdoutWrite;

    /** stderr may be redirected or attached to a different terminal than stdout. */
    const wrapWrite = (origRaw: RawWrite, sharesOutputTerminal: boolean) =>
      /** A stream chunk need not be a complete line; earlier chunks still belong to the user. */
      (chunk: unknown): boolean => {
        const output = String(chunk);
        if (this.rendering) return origRaw(output);
        if (sharesOutputTerminal) this.clearSpinner();
        const result = origRaw(output);
        if (!sharesOutputTerminal) return result;
        if (output.includes('\n')) {
          const lastNewline = output.lastIndexOf('\n');
          this.outputLineOpen = hasVisibleContent(output.slice(lastNewline + 1));
          this.render();
        } else if (hasVisibleContent(output)) {
          this.outputLineOpen = true;
        }
        return result;
      };

    process.stdout.write = wrapWrite(raw, true);
    process.stderr.write = wrapWrite(rawStderrWrite, stderrSharesOutputTerminal);

    if (options.renderImmediately === true) this.render();
    this.intervalId = setInterval(() => this.render(), options.intervalMs ?? 80);
  }

  update(message: string): void {
    if (this.suspendDepth > 0) {
      this.suspendedStatus = { message, options: this.suspendedStatus?.options ?? this.options };
      return;
    }
    this.message = message;
  }

  /** Readline can erase an unfinished body when its prompt begins on that body's line. */
  suspend(): void {
    if (this.suspendDepth > 0) {
      this.suspendDepth++;
      return;
    }
    if (!this.active) {
      this.suspendDepth = 1;
      return;
    }

    const message = this.message;
    const options = this.options;
    if (this.outputLineOpen) {
      this.rawStdoutWrite?.('\n');
      this.outputLineOpen = false;
    }
    this.stop();
    this.suspendedStatus = { message, options };
    this.suspendDepth = 1;
  }

  /** Nested prompt helpers may still own the terminal when an inner helper finishes. */
  resume(): void {
    if (this.suspendDepth === 0) return;
    this.suspendDepth--;
    if (this.suspendDepth > 0) return;

    if (this.suspendedStatus === undefined) return;
    const { message, options } = this.suspendedStatus;
    this.suspendedStatus = undefined;
    this.start(message, options);
  }

  /** Later tasks must not inherit terminal ownership or pending progress from an earlier task. */
  stop(): void {
    this.suspendDepth = 0;
    this.suspendedStatus = undefined;
    this.options = {};
    if (!this.active) return;
    this.active = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
    this.clearSpinner();
    if (this.savedStdoutWrite) {
      process.stdout.write = this.savedStdoutWrite;
      this.savedStdoutWrite = undefined;
    }
    if (this.savedStderrWrite) {
      process.stderr.write = this.savedStderrWrite;
      this.savedStderrWrite = undefined;
    }
    this.rawStdoutWrite = undefined;
  }

  /** Timer ticks can occur between text chunks, where a carriage return would overwrite user text. */
  private render(): void {
    if (!this.rawStdoutWrite || !this.active || this.outputLineOpen) return;
    this.clearSpinner();
    this.rendering = true;
    try {
      const f = FRAMES[this.frame++ % FRAMES.length];
      let line = `${f} ${this.message}`;
      if (this.options.truncate) {
        line = truncateLine(line, process.stdout.columns ?? 80);
      }
      this.rawStdoutWrite(`\r${this.options.dim ? chalk.dim(line) : `${chalk.cyan(line.charAt(0))}${line.slice(1)}`}`);
      this.spinnerRendered = true;
    } finally {
      this.rendering = false;
    }
  }

  /** A newline-free body may occupy the final line even after task completion. */
  private clearSpinner(): void {
    if (!this.rawStdoutWrite || !this.spinnerRendered) return;
    this.rawStdoutWrite('\r\x1b[K');
    this.spinnerRendered = false;
  }
}

export const statusLine = new StatusLineImpl();
