/**
 * Stream display manager for real-time Claude/Codex output.
 *
 * Handles text, thinking, tool use/result events and renders them
 * to the terminal with appropriate formatting and spinners.
 */

import chalk from 'chalk';
import { randomUUID } from 'node:crypto';
import { ToolActivityDisplay, resolveToolActivityDisplayMode } from './ToolActivityDisplay.js';
import type { ToolActivityDisplayMode } from '../tool-activity/types.js';
import { projectToolActivity } from '../tool-activity/presentation.js';
import type { StreamEvent, StreamCallback } from '../types/provider.js';
import { formatToolInput } from './toolInput.js';
import { sanitizeTerminalStreamText, sanitizeTerminalText } from '../utils/text.js';

/** Progress information for stream display */
type ProgressMaxSteps = number | 'infinite';

export interface ProgressInfo {
  /** Current iteration (1-indexed) */
  iteration: number;
  /** Maximum steps allowed */
  maxSteps: ProgressMaxSteps;
  /** Current step index within the workflow (0-indexed) */
  stepIndex: number;
  /** Total number of steps in the workflow */
  totalSteps: number;
}

/** Stream display manager for real-time Claude output */
export class StreamDisplay {
  private activity: ToolActivityDisplay;
  private textBuffer = '';
  private isFirstText = true;
  private isFirstThinking = true;
  private toolSpinner: {
    intervalId: ReturnType<typeof setInterval>;
  } | null = null;
  private spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  private spinnerFrame = 0;

  constructor(
    private agentName: string,
    private quiet: boolean,
    private progressInfo?: ProgressInfo,
    private readonly toolDisplayMode: ToolActivityDisplayMode = resolveToolActivityDisplayMode('terminal', process.stdout.isTTY !== true),
  ) {
    this.activity = this.createActivity();
  }

  private createActivity(): ToolActivityDisplay {
    return new ToolActivityDisplay(this.toolDisplayMode, this.quiet, (line) => console.log(line), false);
  }

  /**
   * Build progress prefix string for display.
   * Format: `(iteration/maxSteps) step stepIndex/totalSteps`
   * Example: `(3/10) step 2/4`
   */
  private buildProgressPrefix(): string {
    if (!this.progressInfo) {
      return '';
    }
    const { iteration, maxSteps, stepIndex, totalSteps } = this.progressInfo;
    return `(${iteration}/${maxSteps}) step ${stepIndex + 1}/${totalSteps}`;
  }

  showInit(model: string): void {
    if (this.quiet || this.toolDisplayMode === 'silent') return;
    const progress = this.buildProgressPrefix();
    const progressPart = progress ? ` ${progress}` : '';
    console.log(chalk.gray(`[${this.agentName}]${progressPart} Model: ${sanitizeTerminalText(model)}`));
  }


  private startToolSpinner(tool: string, inputPreview: string): void {
    this.stopToolSpinner();

    const message = `${chalk.yellow(sanitizeTerminalText(tool))} ${chalk.gray(inputPreview)}`;
    this.toolSpinner = {
      intervalId: setInterval(() => {
        const frame = this.spinnerFrames[this.spinnerFrame];
        this.spinnerFrame = (this.spinnerFrame + 1) % this.spinnerFrames.length;
        process.stdout.write(`\r  ${chalk.cyan(frame)} ${message}`);
      }, 80),
    };
  }

  private stopToolSpinner(): void {
    if (this.toolSpinner) {
      clearInterval(this.toolSpinner.intervalId);
      process.stdout.write('\r\x1b[K');
      this.toolSpinner = null;
      this.spinnerFrame = 0;
    }
  }

  showToolUse(tool: string, input: Record<string, unknown>): void {
    this.handleToolEvent({ type: 'tool_use', data: { id: randomUUID(), tool, input } });
  }

  showToolOutput(output: string, tool?: string): void {
    const running = this.activity.history.entries().filter((entry) => entry.status === 'running');
    const label = tool ?? (running.length === 1 ? running[0]!.tool : 'Tool');
    this.handleToolEvent({ type: 'tool_output', data: { tool: label, output } });
  }

  showToolResult(content: string, isError: boolean): void {
    this.handleToolEvent({ type: 'tool_result', data: { content, isError } });
  }

  private handleToolEvent(event: StreamEvent): void {
    this.stopToolSpinner();
    this.flushThinking();
    this.flushText();
    const entries = this.activity.handle(event);
    if (this.quiet || this.toolDisplayMode !== 'compact') return;
    if (event.type === 'tool_use' || event.type === 'tool_output') {
      const entry = entries.at(-1);
      if (entry && entry.tool !== 'AskUserQuestion') {
        const preview = formatToolInput(entry.tool, entry.input);
        if (event.type === 'tool_use' || preview !== '') this.startToolSpinner(projectToolActivity(entry).tool, preview);
      }
    }
  }

  showThinking(_thinking: string): void {
    if (this.quiet || this.toolDisplayMode === 'silent') return;
    this.stopToolSpinner();
    this.flushText();
    if (this.isFirstThinking) {
      const progress = this.buildProgressPrefix();
      console.log(chalk.magenta(`[${this.agentName}]${progress ? ` ${progress}` : ''} thinking:`));
      this.isFirstThinking = false;
    }
  }

  flushThinking(): void {
    this.isFirstThinking = true;
  }

  showText(text: string): void {
    if (this.quiet || this.toolDisplayMode === 'silent') return;
    this.stopToolSpinner();
    this.flushThinking();

    if (this.isFirstText) {
      console.log();
      const progress = this.buildProgressPrefix();
      const progressPart = progress ? ` ${progress}` : '';
      console.log(chalk.cyan(`[${this.agentName}]${progressPart}:`));
      this.isFirstText = false;
    }
    const sanitized = sanitizeTerminalStreamText(text);
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
    this.activity.flush();
  }

  showResult(success: boolean, error?: string): void {
    if (this.toolDisplayMode === 'silent') return;
    this.stopToolSpinner();
    this.flushThinking();
    this.flushText();
    console.log();
    if (success) {
      console.log(chalk.green('✓ Complete'));
    } else {
      console.log(chalk.red('✗ Failed'));
      if (error) {
        console.log(chalk.red(`  ${sanitizeTerminalText(error)}`));
      }
    }
  }

  reset(): void {
    this.stopToolSpinner();
    this.activity = this.createActivity();
    this.textBuffer = '';
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
          this.handleToolEvent(event);
          break;
        case 'tool_result':
          this.handleToolEvent(event);
          break;
        case 'tool_output':
          this.handleToolEvent(event);
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
        case 'permission_asked':
        case 'assistant_error':
        case 'rate_limit':
        case 'error':
          break;
      }
    };
  }

}
