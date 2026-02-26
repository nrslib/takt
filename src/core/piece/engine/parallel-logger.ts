/**
 * Parallel movement log display
 *
 * Provides prefixed, color-coded interleaved output for parallel sub-movements.
 * Each sub-movement's stream output gets a `[name]` prefix with right-padding
 * aligned to the longest sub-movement name.
 */

import type { StreamCallback, StreamEvent } from '../types.js';
import { stripAnsi } from '../../../shared/utils/text.js';
import { LineTimeSliceBuffer } from './stream-buffer.js';

/** ANSI color codes for sub-movement prefixes (cycled in order) */
const COLORS = ['\x1b[36m', '\x1b[33m', '\x1b[35m', '\x1b[32m'] as const; // cyan, yellow, magenta, green
const RESET = '\x1b[0m';

/** Progress information for parallel logger */
export interface ParallelProgressInfo {
  /** Current iteration (1-indexed) */
  iteration: number;
  /** Maximum movements allowed */
  maxMovements: number;
}

export interface ParallelLoggerOptions {
  /** Sub-movement names (used to calculate prefix width) */
  subMovementNames: string[];
  /** Parent onStream callback to delegate non-prefixed events */
  parentOnStream?: StreamCallback;
  /** Override process.stdout.write for testing */
  writeFn?: (text: string) => void;
  /** Progress information for display */
  progressInfo?: ParallelProgressInfo;
  /** Task label for rich parallel prefix display */
  taskLabel?: string;
  /** Task color index for rich parallel prefix display */
  taskColorIndex?: number;
  /** Parent movement name for rich parallel prefix display */
  parentMovementName?: string;
  /** Parent movement iteration count for rich parallel prefix display */
  movementIteration?: number;
  /** Flush interval for partial text buffers in milliseconds */
  flushIntervalMs?: number;
  /** Minimum buffered chars before timed flush is allowed */
  minTimedFlushChars?: number;
  /** Maximum wait time for timed flush even without boundary */
  maxTimedBufferMs?: number;
}

/**
 * Logger for parallel movement execution.
 *
 * Creates per-sub-movement StreamCallback wrappers that:
 * - Buffer partial lines until newline
 * - Prepend colored `[name]` prefix to each complete line
 * - Delegate init/result/error events to the parent callback
 */
export class ParallelLogger {
  private static readonly DEFAULT_FLUSH_INTERVAL_MS = 300;
  private maxNameLength: number;
  private readonly subMovementNames: string[];
  private readonly lineBuffer: LineTimeSliceBuffer;
  private readonly parentOnStream?: StreamCallback;
  private readonly writeFn: (text: string) => void;
  private readonly progressInfo?: ParallelProgressInfo;
  private totalSubMovements: number;
  private readonly taskLabel?: string;
  private readonly taskColorIndex?: number;
  private readonly parentMovementName?: string;
  private readonly movementIteration?: number;
  private readonly flushIntervalMs: number;

  constructor(options: ParallelLoggerOptions) {
    this.subMovementNames = [...options.subMovementNames];
    this.maxNameLength = Math.max(...this.subMovementNames.map((n) => n.length));
    this.parentOnStream = options.parentOnStream;
    this.writeFn = options.writeFn ?? ((text: string) => process.stdout.write(text));
    this.progressInfo = options.progressInfo;
    this.totalSubMovements = this.subMovementNames.length;
    this.taskLabel = options.taskLabel ? options.taskLabel.slice(0, 4) : undefined;
    this.taskColorIndex = options.taskColorIndex;
    this.parentMovementName = options.parentMovementName;
    this.movementIteration = options.movementIteration;
    this.flushIntervalMs = options.flushIntervalMs ?? ParallelLogger.DEFAULT_FLUSH_INTERVAL_MS;
    this.lineBuffer = new LineTimeSliceBuffer({
      flushIntervalMs: this.flushIntervalMs,
      onTimedFlush: (name, text) => this.flushPartialLine(name, text),
      minTimedFlushChars: options.minTimedFlushChars,
      maxTimedBufferMs: options.maxTimedBufferMs,
    });

    for (const name of this.subMovementNames) {
      this.lineBuffer.addKey(name);
    }
  }

  addSubMovement(name: string): number {
    const existingIndex = this.subMovementNames.indexOf(name);
    if (existingIndex >= 0) {
      return existingIndex;
    }

    this.subMovementNames.push(name);
    this.totalSubMovements = this.subMovementNames.length;
    this.maxNameLength = Math.max(this.maxNameLength, name.length);
    this.lineBuffer.addKey(name);
    return this.subMovementNames.length - 1;
  }

  /**
   * Build the colored prefix string for a sub-movement.
   * Format: `\x1b[COLORm[name](iteration/max) step index/total\x1b[0m` + padding spaces
   */
  buildPrefix(name: string, index: number): string {
    if (this.taskLabel && this.parentMovementName && this.progressInfo && this.movementIteration != null && this.taskColorIndex != null) {
      const taskColor = COLORS[this.taskColorIndex % COLORS.length];
      const { iteration, maxMovements } = this.progressInfo;
      return `${taskColor}[${this.taskLabel}]${RESET}[${this.parentMovementName}][${name}](${iteration}/${maxMovements})(${this.movementIteration}) `;
    }

    const color = COLORS[index % COLORS.length];
    const padding = ' '.repeat(this.maxNameLength - name.length);

    let progressPart = '';
    if (this.progressInfo) {
      const { iteration, maxMovements } = this.progressInfo;
      // index is 0-indexed, display as 1-indexed for step number
      progressPart = `(${iteration}/${maxMovements}) step ${index + 1}/${this.totalSubMovements} `;
    }

    return `${color}[${name}]${RESET}${padding} ${progressPart}`;
  }

  /**
   * Create a StreamCallback wrapper for a specific sub-movement.
   *
   * - `text`: buffered line-by-line with prefix
   * - `tool_use`, `tool_result`, `tool_output`, `thinking`: prefixed per-line, no buffering
   * - `init`, `result`, `error`: delegated to parent callback (no prefix)
   */
  createStreamHandler(subMovementName: string, index: number): StreamCallback {
    const prefix = this.buildPrefix(subMovementName, index);

    return (event: StreamEvent) => {
      switch (event.type) {
        case 'text':
          this.handleTextEvent(subMovementName, prefix, event.data.text);
          break;

        case 'tool_use':
        case 'tool_result':
        case 'tool_output':
        case 'thinking':
          this.handleBlockEvent(prefix, event);
          break;

        case 'init':
        case 'result':
        case 'error':
          // Delegate to parent without prefix
          this.parentOnStream?.(event);
          break;
      }
    };
  }

  /**
   * Handle text event with line buffering.
   * Buffer until newline, then output prefixed complete lines.
   * Empty lines get no prefix per spec.
   */
  private handleTextEvent(name: string, prefix: string, text: string): void {
    const parts = this.lineBuffer.push(name, stripAnsi(text));

    // Output all complete lines
    for (const line of parts) {
      if (line === '') {
        this.writeFn('\n');
      } else {
        this.writeFn(`${prefix}${line}\n`);
      }
    }
  }

  private flushPartialLine(name: string, text: string): void {
    const index = this.subMovementNames.indexOf(name);
    const prefix = this.buildPrefix(name, index < 0 ? 0 : index);
    this.writeFn(`${prefix}${text}\n`);
  }

  /**
   * Handle block events (tool_use, tool_result, tool_output, thinking).
   * Output with prefix, splitting multi-line content.
   */
  private handleBlockEvent(prefix: string, event: StreamEvent): void {
    let text: string;
    switch (event.type) {
      case 'tool_use':
        text = `[tool] ${event.data.tool}`;
        break;
      case 'tool_result':
        text = stripAnsi(event.data.content);
        break;
      case 'tool_output':
        text = stripAnsi(event.data.output);
        break;
      case 'thinking':
        text = stripAnsi(event.data.thinking);
        break;
      default:
        return;
    }

    for (const line of text.split('\n')) {
      if (line === '') {
        this.writeFn('\n');
      } else {
        this.writeFn(`${prefix}${line}\n`);
      }
    }
  }

  /**
   * Build the prefix string for summary lines (no sub-movement name).
   * Returns empty string in non-rich mode (no task-level prefix needed).
   */
  private buildSummaryPrefix(): string {
    if (this.taskLabel && this.parentMovementName && this.progressInfo && this.movementIteration != null && this.taskColorIndex != null) {
      const taskColor = COLORS[this.taskColorIndex % COLORS.length];
      const { iteration, maxMovements } = this.progressInfo;
      return `${taskColor}[${this.taskLabel}]${RESET}[${this.parentMovementName}](${iteration}/${maxMovements})(${this.movementIteration}) `;
    }
    return '';
  }

  /**
   * Flush remaining line buffers for all sub-movements.
   * Call after all sub-movements complete to output any trailing partial lines.
   */
  flush(): void {
    const pending = this.lineBuffer.flushAll();
    for (const { key, text } of pending) {
      this.flushPartialLine(key, text);
    }
  }

  /**
   * Print completion summary after all sub-movements finish.
   *
   * Format:
   * ```
   * ── parallel-review results ──
   *   arch-review:     approved
   *   security-review: rejected
   * ──────────────────────────────
   * ```
   */
  printSummary(
    parentMovementName: string,
    results: Array<{ name: string; condition: string | undefined }>,
  ): void {
    this.flush();

    const maxResultNameLength = Math.max(...results.map((r) => r.name.length));

    const resultLines = results.map((r) => {
      const padding = ' '.repeat(maxResultNameLength - r.name.length);
      const condition = r.condition ?? '(no result)';
      return `  ${r.name}:${padding} ${condition}`;
    });

    // Header line: ── name results ──
    const headerText = ` ${parentMovementName} results `;
    const maxLineLength = Math.max(
      headerText.length + 4, // 4 for "── " + " ──"
      ...resultLines.map((l) => l.length),
    );
    const sideWidth = Math.max(1, Math.floor((maxLineLength - headerText.length) / 2));
    const headerLine = `${'─'.repeat(sideWidth)}${headerText}${'─'.repeat(sideWidth)}`;
    const footerLine = '─'.repeat(headerLine.length);

    const summaryPrefix = this.buildSummaryPrefix();
    this.writeFn(`${summaryPrefix}${headerLine}\n`);
    for (const line of resultLines) {
      this.writeFn(`${summaryPrefix}${line}\n`);
    }
    this.writeFn(`${summaryPrefix}${footerLine}\n`);
  }
}
