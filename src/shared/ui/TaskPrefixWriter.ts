/**
 * Line-buffered, prefixed writer for task-level parallel execution.
 *
 * When multiple tasks run concurrently (takt run --concurrency N), each task's
 * output must be identifiable and line-aligned to prevent mid-line interleaving.
 * This class wraps process.stdout.write with line buffering and a colored
 * `[taskName]` prefix on every non-empty line.
 *
 * Design mirrors ParallelLogger (movement-level) but targets task-level output:
 * - Regular log lines (info, header, status) get the prefix
 * - Stream output gets line-buffered then prefixed
 * - Empty lines are passed through without prefix
 */

import { stripAnsi } from '../utils/text.js';

/** ANSI color codes for task prefixes (cycled by task index) */
const TASK_COLORS = ['\x1b[36m', '\x1b[33m', '\x1b[35m', '\x1b[32m'] as const;
const RESET = '\x1b[0m';

export interface TaskPrefixWriterOptions {
  /** Task name used in the prefix */
  taskName: string;
  /** Color index for the prefix (cycled mod 4) */
  colorIndex: number;
  /** Override process.stdout.write for testing */
  writeFn?: (text: string) => void;
}

/**
 * Prefixed line writer for a single parallel task.
 *
 * All output goes through `writeLine` (complete lines) or `writeChunk`
 * (buffered partial lines). The prefix `[taskName]` is prepended to every
 * non-empty output line.
 */
export class TaskPrefixWriter {
  private readonly prefix: string;
  private readonly writeFn: (text: string) => void;
  private lineBuffer = '';

  constructor(options: TaskPrefixWriterOptions) {
    const color = TASK_COLORS[options.colorIndex % TASK_COLORS.length];
    this.prefix = `${color}[${options.taskName}]${RESET} `;
    this.writeFn = options.writeFn ?? ((text: string) => process.stdout.write(text));
  }

  /**
   * Write a complete line with prefix.
   * Multi-line text is split and each non-empty line gets the prefix.
   */
  writeLine(text: string): void {
    const cleaned = stripAnsi(text);
    const lines = cleaned.split('\n');

    for (const line of lines) {
      if (line === '') {
        this.writeFn('\n');
      } else {
        this.writeFn(`${this.prefix}${line}\n`);
      }
    }
  }

  /**
   * Write a chunk of streaming text with line buffering.
   * Partial lines are buffered until a newline arrives, then output with prefix.
   */
  writeChunk(text: string): void {
    const cleaned = stripAnsi(text);
    const combined = this.lineBuffer + cleaned;
    const parts = combined.split('\n');

    const remainder = parts.pop() ?? '';
    this.lineBuffer = remainder;

    for (const line of parts) {
      if (line === '') {
        this.writeFn('\n');
      } else {
        this.writeFn(`${this.prefix}${line}\n`);
      }
    }
  }

  /**
   * Flush any remaining buffered content.
   */
  flush(): void {
    if (this.lineBuffer !== '') {
      this.writeFn(`${this.prefix}${this.lineBuffer}\n`);
      this.lineBuffer = '';
    }
  }

}
