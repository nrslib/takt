/**
 * Stream display manager for real-time Claude/Codex output.
 *
 * Handles text, thinking, tool use/result events and renders them
 * to the terminal with appropriate formatting and spinners.
 */

import chalk from 'chalk';
// NOTE: type-only import from core — acceptable because StreamDisplay is
// a UI renderer tightly coupled to the piece event protocol.
// Moving StreamEvent/StreamCallback to shared would require relocating all
// dependent event-data types, which is out of scope for this refactoring.
import type { StreamEvent, StreamCallback } from '../../core/piece/index.js';
import { truncate } from './LogManager.js';
import { stripAnsi } from '../utils/text.js';

/** Progress information for stream display */
export interface ProgressInfo {
  /** Current iteration (1-indexed) */
  iteration: number;
  /** Maximum movements allowed */
  maxMovements: number;
  /** Current movement index within piece (0-indexed) */
  movementIndex: number;
  /** Total number of movements in piece */
  totalMovements: number;
}

/** Stream display manager for real-time Claude output */
export class StreamDisplay {
  private lastToolUse: string | null = null;
  private currentToolInputPreview: string | null = null;
  private toolOutputBuffer = '';
  private toolOutputPrinted = false;
  private textBuffer = '';
  private thinkingBuffer = '';
  private isFirstText = true;
  private isFirstThinking = true;
  private toolSpinner: {
    intervalId: ReturnType<typeof setInterval>;
    toolName: string;
    message: string;
  } | null = null;
  private spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  private spinnerFrame = 0;

  constructor(
    private agentName: string,
    private quiet: boolean,
    private progressInfo?: ProgressInfo,
  ) {}

  /**
   * Build progress prefix string for display.
   * Format: `(iteration/maxMovements) step movementIndex/totalMovements`
   * Example: `(3/10) step 2/4`
   */
  private buildProgressPrefix(): string {
    if (!this.progressInfo) {
      return '';
    }
    const { iteration, maxMovements, movementIndex, totalMovements } = this.progressInfo;
    // movementIndex is 0-indexed, display as 1-indexed
    return `(${iteration}/${maxMovements}) step ${movementIndex + 1}/${totalMovements}`;
  }

  showInit(model: string): void {
    if (this.quiet) return;
    const progress = this.buildProgressPrefix();
    const progressPart = progress ? ` ${progress}` : '';
    console.log(chalk.gray(`[${this.agentName}]${progressPart} Model: ${model}`));
  }

  private startToolSpinner(tool: string, inputPreview: string): void {
    this.stopToolSpinner();

    const message = `${chalk.yellow(tool)} ${chalk.gray(inputPreview)}`;
    this.toolSpinner = {
      intervalId: setInterval(() => {
        const frame = this.spinnerFrames[this.spinnerFrame];
        this.spinnerFrame = (this.spinnerFrame + 1) % this.spinnerFrames.length;
        process.stdout.write(`\r  ${chalk.cyan(frame)} ${message}`);
      }, 80),
      toolName: tool,
      message,
    };
  }

  private stopToolSpinner(): void {
    if (this.toolSpinner) {
      clearInterval(this.toolSpinner.intervalId);
      process.stdout.write('\r' + ' '.repeat(120) + '\r');
      this.toolSpinner = null;
      this.spinnerFrame = 0;
    }
  }

  showToolUse(tool: string, input: Record<string, unknown>): void {
    if (this.quiet) return;
    this.flushText();
    const inputPreview = this.formatToolInput(tool, input);
    this.startToolSpinner(tool, inputPreview);
    this.lastToolUse = tool;
    this.currentToolInputPreview = inputPreview;
    this.toolOutputBuffer = '';
    this.toolOutputPrinted = false;
  }

  showToolOutput(output: string, tool?: string): void {
    if (this.quiet) return;
    if (!output) return;
    this.stopToolSpinner();
    this.flushThinking();
    this.flushText();

    if (tool && !this.lastToolUse) {
      this.lastToolUse = tool;
    }

    this.toolOutputBuffer += stripAnsi(output);
    const lines = this.toolOutputBuffer.split(/\r?\n/);
    this.toolOutputBuffer = lines.pop() ?? '';

    this.printToolOutputLines(lines, tool);

    if (this.lastToolUse && this.currentToolInputPreview) {
      this.startToolSpinner(this.lastToolUse, this.currentToolInputPreview);
    }
  }

  showToolResult(content: string, isError: boolean): void {
    this.stopToolSpinner();
    const sanitizedContent = stripAnsi(content);

    if (this.quiet) {
      if (isError) {
        const toolName = this.lastToolUse || 'Tool';
        const errorContent = sanitizedContent || 'Unknown error';
        console.log(chalk.red(`  ✗ ${toolName}:`), chalk.red(truncate(errorContent, 70)));
      }
      this.lastToolUse = null;
      this.currentToolInputPreview = null;
      this.toolOutputPrinted = false;
      return;
    }

    if (this.toolOutputBuffer) {
      this.printToolOutputLines([this.toolOutputBuffer], this.lastToolUse ?? undefined);
      this.toolOutputBuffer = '';
    }

    const toolName = this.lastToolUse || 'Tool';
    if (isError) {
      const errorContent = sanitizedContent || 'Unknown error';
      console.log(chalk.red(`  ✗ ${toolName}:`), chalk.red(truncate(errorContent, 70)));
    } else if (sanitizedContent && sanitizedContent.length > 0) {
      const preview = sanitizedContent.split('\n')[0] || sanitizedContent;
      console.log(chalk.green(`  ✓ ${toolName}`), chalk.gray(truncate(preview, 60)));
    } else {
      console.log(chalk.green(`  ✓ ${toolName}`));
    }
    this.lastToolUse = null;
    this.currentToolInputPreview = null;
    this.toolOutputPrinted = false;
  }

  showThinking(thinking: string): void {
    if (this.quiet) return;
    this.stopToolSpinner();
    this.flushText();

    if (this.isFirstThinking) {
      console.log();
      const progress = this.buildProgressPrefix();
      const progressPart = progress ? ` ${progress}` : '';
      console.log(chalk.magenta(`💭 [${this.agentName}]${progressPart} thinking:`));
      this.isFirstThinking = false;
    }
    const sanitized = stripAnsi(thinking);
    process.stdout.write(chalk.gray.italic(sanitized));
    this.thinkingBuffer += sanitized;
  }

  flushThinking(): void {
    if (this.thinkingBuffer) {
      if (!this.thinkingBuffer.endsWith('\n')) {
        console.log();
      }
      this.thinkingBuffer = '';
      this.isFirstThinking = true;
    }
  }

  showText(text: string): void {
    if (this.quiet) return;
    this.stopToolSpinner();
    this.flushThinking();

    if (this.isFirstText) {
      console.log();
      const progress = this.buildProgressPrefix();
      const progressPart = progress ? ` ${progress}` : '';
      console.log(chalk.cyan(`[${this.agentName}]${progressPart}:`));
      this.isFirstText = false;
    }
    const sanitized = stripAnsi(text);
    process.stdout.write(sanitized);
    this.textBuffer += sanitized;
  }

  flushText(): void {
    if (this.textBuffer) {
      if (!this.textBuffer.endsWith('\n')) {
        console.log();
      }
      this.textBuffer = '';
      this.isFirstText = true;
    }
  }

  flush(): void {
    this.stopToolSpinner();
    this.flushThinking();
    this.flushText();
  }

  showResult(success: boolean, error?: string): void {
    this.stopToolSpinner();
    this.flushThinking();
    this.flushText();
    console.log();
    if (success) {
      console.log(chalk.green('✓ Complete'));
    } else {
      console.log(chalk.red('✗ Failed'));
      if (error) {
        console.log(chalk.red(`  ${error}`));
      }
    }
  }

  reset(): void {
    this.stopToolSpinner();
    this.lastToolUse = null;
    this.currentToolInputPreview = null;
    this.toolOutputBuffer = '';
    this.toolOutputPrinted = false;
    this.textBuffer = '';
    this.thinkingBuffer = '';
    this.isFirstText = true;
    this.isFirstThinking = true;
  }

  createHandler(): StreamCallback {
    return (event: StreamEvent): void => {
      switch (event.type) {
        case 'init':
          this.showInit(event.data.model);
          break;
        case 'tool_use':
          this.showToolUse(event.data.tool, event.data.input);
          break;
        case 'tool_result':
          this.showToolResult(event.data.content, event.data.isError);
          break;
        case 'tool_output':
          this.showToolOutput(event.data.output, event.data.tool);
          break;
        case 'text':
          this.showText(event.data.text);
          break;
        case 'thinking':
          this.showThinking(event.data.thinking);
          break;
        case 'result':
          this.showResult(event.data.success, event.data.error);
          break;
        case 'error':
          break;
      }
    };
  }

  private formatToolInput(tool: string, input: Record<string, unknown>): string {
    switch (tool) {
      case 'Bash':
        return truncate(String(input.command || ''), 60);
      case 'Read':
        return truncate(String(input.file_path || ''), 60);
      case 'Write':
      case 'Edit':
        return truncate(String(input.file_path || ''), 60);
      case 'Glob':
        return truncate(String(input.pattern || ''), 60);
      case 'Grep':
        return truncate(String(input.pattern || ''), 60);
      default: {
        const keys = Object.keys(input);
        if (keys.length === 0) return '';
        const firstKey = keys[0];
        if (firstKey) {
          const value = input[firstKey];
          return truncate(String(value || ''), 50);
        }
        return '';
      }
    }
  }

  private ensureToolOutputHeader(tool?: string): void {
    if (this.toolOutputPrinted) return;
    const label = tool || this.lastToolUse || 'Tool';
    console.log(chalk.gray(`  ${chalk.yellow(label)} output:`));
    this.toolOutputPrinted = true;
  }

  private printToolOutputLines(lines: string[], tool?: string): void {
    if (lines.length === 0) return;
    this.ensureToolOutputHeader(tool);
    for (const line of lines) {
      console.log(chalk.gray(`  │ ${line}`));
    }
  }
}
