import type { StreamEvent } from '../types/provider.js';
import { ToolActivityHistory } from '../tool-activity/history.js';
import { classifyToolResult, StreamingToolOutput } from '../tool-activity/result.js';
import { RunningToolResult } from '../tool-activity/runningResult.js';
import { toolResultSensitiveValues, writeToolResultText } from '../tool-activity/sanitize.js';
import { CI_RESULT_BYTES, CI_RESULT_LINES, COMPACT_RESULT_BYTES, COMPACT_RESULT_LINES, formatToolActivityTime, groupToolActivities,
  projectLabel, projectToolActivity, toolActivityDetail, toolActivityResultView, type ToolActivityResultView } from '../tool-activity/presentation.js';
import type { ToolActivityDisplayMode, ToolActivityEntry, ToolActivityGroup, ToolActivityHistoryState, ToolActivityProjection,
  ToolActivityTurnUpdate } from '../tool-activity/types.js';
import { truncateUtf8 } from '../utils/utf8.js';
import { createSensitiveTextStreamRedactor, type SensitiveTextStreamRedactor } from '../utils/sensitiveText.js';
import { truncate } from './LogManager.js';

interface StreamOutputState {
  redactor: SensitiveTextStreamRedactor;
  pending: string;
  printed: string;
  printedLines: number;
  printedBytes: number;
  omitted: boolean;
  omissionPrinted: boolean;
  headerTool: string;
  output: StreamingToolOutput;
}

/** 完了した entry は、最終結果だけが持つ秘密値（JSON の項目名で判る値など）も照合に使う。 */
function toolOutputSensitiveSource(entry: ToolActivityEntry): unknown {
  return entry.status === 'running' ? entry.input
    : [entry.input, entry.result, classifyToolResult(entry.result ?? '', true).parsed];
}

export function resolveToolActivityDisplayMode(
  outputMode: 'terminal' | 'silent',
  expanded: boolean,
): ToolActivityDisplayMode {
  return outputMode === 'silent' ? 'silent' : expanded ? 'expanded' : 'compact';
}

export class ToolActivityDisplay {
  readonly history = new ToolActivityHistory();
  private readonly streams = new Map<string, StreamOutputState>();
  private readonly completed = new Map<string, ToolActivityEntry['status']>();
  private readonly displayedResults = new Map<string, { text: string; bytes: number; lines: number; truncated: boolean }>();
  /** 表示用の結果。実行中の entry は追記分だけで更新し、完了した entry は完了時に一度だけ作る。 */
  private readonly runningResults = new Map<string, RunningToolResult>();
  private readonly completedResults = new Map<string, ToolActivityResultView>();

  constructor(
    readonly mode: ToolActivityDisplayMode,
    private readonly quiet: boolean,
    private readonly writeLine: (text: string) => void,
    private readonly showCompactStarts: boolean,
  ) {}

  handle(event: StreamEvent): ToolActivityEntry[] {
    const entries = this.history.apply(event);
    for (const entry of entries) this.updateResult(entry);
    if (this.mode === 'silent') return entries;
    for (const entry of entries) {
      if (event.type === 'tool_use') {
        if (this.mode === 'expanded' || (this.showCompactStarts && !this.quiet)) {
          const value = projectToolActivity(entry, this.mode);
          this.writeLine(`[tool] ${value.tool} ${value.action} ${value.input} [running @${formatToolActivityTime(entry.startedAt!)}]`);
        }
      } else if (event.type === 'tool_output') {
        if (this.mode === 'compact' && !this.quiet) this.stream(entry, event.data.tool);
      } else if (event.type === 'tool_result') {
        this.complete(entry);
      }
    }
    return entries;
  }

  restore(state: ToolActivityHistoryState): void {
    this.history.restore(state);
    this.streams.clear();
    this.completed.clear();
    this.displayedResults.clear();
    this.runningResults.clear();
    this.completedResults.clear();
    for (const entry of this.history.entries()) {
      this.updateResult(entry);
      if (entry.status !== 'running') this.completed.set(entry.key, entry.status);
    }
  }

  /** 受け取った差分を、履歴全体を作り直さずに適用する。起点が一致しなければ何もせず false を返す。 */
  applyUpdate(update: ToolActivityTurnUpdate): boolean {
    const entries = this.history.applyUpdate(update);
    if (entries === undefined) return false;
    for (const entry of entries) {
      this.updateResult(entry);
      if (entry.status !== 'running') this.completed.set(entry.key, entry.status);
    }
    return true;
  }

  /** 変わった entry の表示用の結果を更新する。結果が訂正されたときも、完了した entry として作り直す。 */
  private updateResult(entry: ToolActivityEntry): void {
    if (entry.status !== 'running') {
      this.runningResults.delete(entry.key);
      this.completedResults.set(entry.key, toolActivityResultView(entry));
      return;
    }
    let result = this.runningResults.get(entry.key);
    if (result === undefined) {
      result = new RunningToolResult();
      this.runningResults.set(entry.key, result);
    }
    result.read(entry);
  }

  private runningResult(entry: ToolActivityEntry): RunningToolResult {
    const result = this.runningResults.get(entry.key);
    if (result === undefined) throw new Error(`Running tool activity ${entry.key} has no result`);
    return result;
  }

  private resultView(entry: ToolActivityEntry): ToolActivityResultView {
    if (entry.status === 'running') return this.runningResult(entry).view();
    const view = this.completedResults.get(entry.key);
    if (view === undefined) throw new Error(`Completed tool activity ${entry.key} has no result`);
    return view;
  }

  /** 秘密値を伏せたツール名。保持している結果の秘密値を使い、出力全体を処理し直さない。 */
  toolLabel(entry: ToolActivityEntry): string {
    return projectLabel(entry.tool, this.resultView(entry).sensitiveValues);
  }

  groups(): ToolActivityGroup[] {
    const entries = this.history.entries();
    return groupToolActivities(entries, new Map(entries.map((entry) => [entry.key, this.resultView(entry)])));
  }

  detail(key: string, offset: number): ToolActivityProjection {
    const entry = this.history.get(key);
    if (entry === undefined) throw new RangeError('Unknown tool activity key');
    const view = this.resultView(entry);
    return { ...projectToolActivity(entry, 'expanded', view), result: toolActivityDetail(entry, offset, undefined, undefined, view) };
  }

  flush(): void {
    if (this.mode === 'silent') return;
    for (const entry of this.history.entries()) {
      if (entry.status !== 'running') continue;
      if (this.mode === 'expanded' && entry.output !== '') {
        // テキストの出力は、redactor が確定した行だけを出す。出力全体をマスクし直すと、改行の届いていない行の途中まで出てしまう。
        const isReadableText = classifyToolResult(entry.output, false).kind === 'text';
        const value = projectToolActivity(entry, 'expanded', isReadableText ? this.runningResult(entry).view() : undefined);
        if (!this.displayedResults.has(entry.key)) this.writeLine(`  ${value.tool} output: [running]`);
        this.writeExpandedResult(value);
      } else if (this.mode === 'compact' && !this.quiet) {
        this.flushStream(entry);
      }
    }
  }

  private newStream(entry: ToolActivityEntry, tool: string): StreamOutputState {
    return {
      redactor: createSensitiveTextStreamRedactor(), pending: '', printed: '',
      printedLines: 0, printedBytes: 0,
      omitted: false, omissionPrinted: false,
      headerTool: projectToolActivity({ ...entry, tool: tool || entry.tool }).tool, output: new StreamingToolOutput(),
    };
  }

  private stream(entry: ToolActivityEntry, tool: string): void {
    let state = this.streams.get(entry.key);
    if (state === undefined) {
      state = this.newStream(entry, tool);
      this.streams.set(entry.key, state);
    }
    if (state.omitted) return;
    const appended = state.output.read(entry.output);
    if (appended === '') return;
    state.pending += writeToolResultText(state.redactor, appended, entry.input);
    this.drain(state, false);
  }

  private drain(state: StreamOutputState, flush: boolean): void {
    while (state.pending !== '') {
      const newline = state.pending.indexOf('\n');
      if (newline < 0 && !flush && state.pending.length <= COMPACT_RESULT_BYTES) return;
      const length = newline < 0 ? state.pending.length : newline;
      const line = state.pending.slice(0, length);
      state.pending = state.pending.slice(length + (newline < 0 ? 0 : 1));
      const lineBytes = Buffer.byteLength(line, 'utf8');
      if (state.printedLines >= COMPACT_RESULT_LINES || state.printedBytes + lineBytes > COMPACT_RESULT_BYTES) {
        state.omitted = true;
        state.pending = '';
        return;
      }
      if (state.printedLines === 0) this.writeLine(`  ${state.headerTool || 'Tool'} output:`);
      this.writeLine(`  │ ${line}`);
      state.printed += line + (newline < 0 ? '' : '\n');
      state.printedLines += 1;
      state.printedBytes += lineBytes + 1;
    }
  }

  private flushStream(entry: ToolActivityEntry): void {
    const state = this.streams.get(entry.key);
    if (state === undefined) return;
    if (state.omitted) {
      this.writeStreamOmission(state);
      return;
    }
    const result = classifyToolResult(entry.output, entry.status !== 'running');
    if (result.kind === 'pending') return;
    if (result.kind === 'structured') {
      const value = projectToolActivity(entry);
      const previous = state.printed.replace(/\n$/u, '');
      if (previous === value.result.text) return;
      state.pending = value.result.text.startsWith(previous)
        ? value.result.text.slice(previous.length).replace(/^\n/u, '') : value.result.text;
      this.drain(state, true);
      if (value.result.truncated || state.omitted) {
        this.writeStreamOmission(state);
        state.omitted = true;
      } else state.printed = value.result.text;
      return;
    }
    // 実行中に保留した出力（`[` で始まるテキストなど）は、完了時にここで初めて redactor へ渡る。
    // 実行中は redactor が確定した行だけを出し、改行の届いていない行は完了まで出さない。
    const sensitiveSource = toolOutputSensitiveSource(entry);
    const written = writeToolResultText(state.redactor, state.output.readRest(result.text), sensitiveSource);
    state.pending += entry.status === 'running' ? written
      : written + state.redactor.flush(toolResultSensitiveValues(sensitiveSource));
    this.drain(state, true);
  }

  private complete(entry: ToolActivityEntry): void {
    if (this.completed.get(entry.key) === entry.status) return;
    this.completed.set(entry.key, entry.status);
    if (this.mode === 'compact') this.flushStream(entry);
    const value = projectToolActivity(entry, this.mode === 'expanded' ? 'expanded' : 'compact', this.resultView(entry));
    const failed = value.status === 'failure';
    if (this.mode === 'compact' && this.quiet && !failed) return;
    const symbol = failed ? '✗' : '✓';
    const suppressed = entry.tool === 'AskUserQuestion' && !failed;
    if (this.mode === 'expanded') {
      const duration = value.durationMs === undefined ? '' : ` (${value.durationMs} ms)`;
      this.writeLine(`  ${symbol} ${value.tool} ${value.action} ${value.input}${duration} [${value.status}]`);
      if (!suppressed) this.writeExpandedResult(value);
    } else {
      const state = this.streams.get(entry.key);
      const alreadyPrinted = state?.printed.replace(/\n$/u, '') === value.result.text;
      const firstLine = value.result.text.split('\n', 1)[0] ?? '';
      const preview = suppressed || alreadyPrinted ? '' : truncate(firstLine || (failed ? 'Unknown error' : ''), failed ? 70 : 60);
      this.writeLine(`  ${symbol} ${value.tool}${failed ? ':' : ''}${preview === '' ? '' : ` ${preview}`}`);
      if (value.result.truncated || state?.omitted) {
        if (state === undefined) this.writeLine('  [output truncated; more available]');
        else this.writeStreamOmission(state);
      }
    }
  }

  private writeStreamOmission(state: StreamOutputState): void {
    if (state.omissionPrinted) return;
    this.writeLine('  [output truncated; more available]');
    state.omissionPrinted = true;
  }

  private writeResult(text: string, truncated: boolean): void {
    if (text !== '') {
      for (const line of text.split('\n')) this.writeLine(`  │ ${line}`);
    }
    if (truncated) this.writeLine('  [output truncated; more available]');
  }

  private writeExpandedResult(value: ToolActivityProjection): void {
    const previous = this.displayedResults.get(value.key);
    if (previous?.truncated) return;
    if (previous?.text === value.result.text) {
      if (value.result.truncated) {
        this.writeResult('', true);
        this.displayedResults.set(value.key, { ...previous, truncated: true });
      }
      return;
    }
    if (previous === undefined) {
      this.writeResult(value.result.text, value.result.truncated);
      this.displayedResults.set(value.key, {
        text: value.result.text, bytes: Buffer.byteLength(value.result.text),
        lines: value.result.text === '' ? 0 : value.result.text.split('\n').length,
        truncated: value.result.truncated,
      });
      return;
    }
    const remaining = value.result.text.startsWith(previous.text)
      ? value.result.text.slice(previous.text.length).replace(/^\n/u, '') : value.result.text;
    const remainingLines = CI_RESULT_LINES - previous.lines;
    const remainingBytes = Math.max(0, CI_RESULT_BYTES - previous.bytes - (previous.lines > 0 ? 1 : 0));
    const lines = remaining.split('\n');
    const bounded = truncateUtf8(lines.slice(0, Math.max(0, remainingLines)).join('\n'), remainingBytes).value;
    const truncated = value.result.truncated || lines.length > remainingLines || bounded.length < remaining.length;
    this.writeResult(bounded, truncated);
    this.displayedResults.set(value.key, {
      text: value.result.text,
      bytes: previous.bytes + Buffer.byteLength(bounded) + (previous.lines > 0 && bounded !== '' ? 1 : 0),
      lines: previous.lines + (bounded === '' ? 0 : bounded.split('\n').length), truncated,
    });
  }
}
