/**
 * Persistent status line spinner.
 *
 * Shows an animated spinner on the last line of the terminal.
 * Regular output scrolls above it. Intercepts both stdout and stderr
 * writes to clear and redraw the spinner around each write.
 */

import chalk from 'chalk';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

type RawWrite = (str: string) => boolean;

class StatusLineImpl {
  private active = false;
  private message = '';
  private frame = 0;
  private intervalId?: ReturnType<typeof setInterval>;
  private rawStdoutWrite?: RawWrite;
  private savedStdoutWrite?: typeof process.stdout.write;
  private savedStderrWrite?: typeof process.stderr.write;
  private rendering = false;

  start(message: string): void {
    if (this.active) {
      this.message = message;
      return;
    }
    if (!process.stdout.isTTY) return;

    this.active = true;
    this.message = message;
    this.frame = 0;

    this.savedStdoutWrite = process.stdout.write;
    this.savedStderrWrite = process.stderr.write;
    this.rawStdoutWrite = process.stdout.write.bind(process.stdout) as RawWrite;
    const rawStderrWrite = process.stderr.write.bind(process.stderr) as RawWrite;
    const raw = this.rawStdoutWrite;

    const wrapWrite = (origRaw: RawWrite) =>
      (chunk: unknown): boolean => {
        if (this.rendering) return origRaw(String(chunk));
        raw('\r\x1b[K');
        const result = origRaw(String(chunk));
        if (String(chunk).includes('\n')) this.render();
        return result;
      };

    process.stdout.write = wrapWrite(raw);
    process.stderr.write = wrapWrite(rawStderrWrite);

    this.intervalId = setInterval(() => this.render(), 80);
  }

  update(message: string): void {
    this.message = message;
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
    if (this.rawStdoutWrite) {
      this.rawStdoutWrite('\r\x1b[K');
    }
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

  private render(): void {
    if (!this.rawStdoutWrite || !this.active) return;
    this.rendering = true;
    const f = FRAMES[this.frame++ % FRAMES.length];
    this.rawStdoutWrite(`\r${chalk.cyan(f)} ${this.message}`);
    this.rendering = false;
  }
}

export const statusLine = new StatusLineImpl();
