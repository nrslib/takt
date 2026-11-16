import type { StreamEvent } from '../types/provider.js';
import { ToolActivityHistory } from '../tool-activity/history.js';
import { classifyToolResult } from '../tool-activity/result.js';
import { RunningToolResult } from '../tool-activity/runningResult.js';
import { normalizeToolResultText, toolResultSensitiveValues } from '../tool-activity/sanitize.js';
import { CI_RESULT_BYTES, CI_RESULT_LINES, COMPACT_RESULT_BYTES, COMPACT_RESULT_LINES, groupToolActivities,
  projectLabel, projectToolActivity, toolActivityDetail, toolActivityResultView, type ToolActivityResultView } from '../tool-activity/presentation.js';
import type { ToolActivityDisplayMode, ToolActivityEntry, ToolActivityGroup, ToolActivityProjection } from '../tool-activity/types.js';
import { RETAINED_TOOL_OUTPUT_BYTES } from '../tool-activity/outputLimit.js';
import { truncateUtf8 } from '../utils/utf8.js';
import { createBoundedSensitiveValues, createSensitiveTextStreamRedactor, type SensitiveTextStreamRedactor } from '../utils/sensitiveText.js';
import { REDACTED_VALUE } from '../utils/sensitive-text.js';
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
  consumed: number;
  /** 実行中の flush で仮に表示した、まだ確定していない末尾。 */
  previewed: string;
}

/** 実行中の一覧と詳細では、仮の表示の末尾で伏せた部分（書きかけの値や既知の値の先頭部分）を出さずに保留する。 */
function withoutHeldTail(preview: string): string {
  return preview.endsWith(REDACTED_VALUE) ? preview.slice(0, -REDACTED_VALUE.length) : preview;
}

/** 追記だけの端末出力で、仮に印字した末尾が確定した文字列と食い違っても、印字済みの部分を印字し直さない。 */
function unprinted(printed: string, text: string): string {
  let shared = 0;
  while (shared < printed.length && printed[shared] === text[shared]) shared++;
  return shared === 0 ? text : text.slice(shared).replace(/^\n/u, '');
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
  /** 通常TUIの未マスク出力は、分割された秘密値を確定前に表示しない。 */
  private readonly runningResults = new Map<string, RunningToolResult>();
  private readonly previews = new Map<string, string>();

  constructor(
    readonly mode: ToolActivityDisplayMode,
    private readonly quiet: boolean,
    private readonly writeLine: (text: string) => void,
    private readonly showCompactStarts: boolean,
    private readonly committedOutput = false,
  ) {}

  handle(event: StreamEvent): ToolActivityEntry[] {
    const entries = this.history.apply(event);
    for (const entry of entries) this.updateResult(entry);
    if (this.mode === 'silent') return entries;
    for (const entry of entries) {
      if (event.type === 'tool_use') {
        if (this.mode === 'expanded' || (this.showCompactStarts && !this.quiet)) {
          const value = projectToolActivity(entry, this.mode, this.resultView(entry));
          this.writeLine(`[tool] ${value.tool} ${value.action} ${value.input} [running @${entry.startedAt}]`);
        }
      } else if (event.type === 'tool_output') {
        if (this.mode === 'compact' && !this.quiet) this.stream(entry, event.data.tool);
      } else if (event.type === 'tool_result') {
        this.complete(entry);
      }
    }
    return entries;
  }

  upsert(entry: ToolActivityEntry): void {
    this.history.upsert(entry);
    this.updateResult(entry);
  }

  appendOutput(key: string, text: string, tail: string): void {
    const entry = this.history.appendOutput(key, text, RETAINED_TOOL_OUTPUT_BYTES);
    if (entry === undefined) return;
    this.previews.set(key, tail);
    this.updateResult(entry);
  }

  /** daemon の確定済み出力には、通常TUI向けの再マスクを適用しない。 */
  private updateResult(entry: ToolActivityEntry): void {
    if (entry.status !== 'running') {
      this.runningResults.delete(entry.key);
      this.previews.delete(entry.key);
      return;
    }
    if (!this.committedOutput) {
      let result = this.runningResults.get(entry.key);
      if (result === undefined) {
        result = new RunningToolResult();
        this.runningResults.set(entry.key, result);
      }
      result.read(entry);
    }
  }

  private runningResult(entry: ToolActivityEntry): RunningToolResult {
    const result = this.runningResults.get(entry.key);
    if (result === undefined) throw new Error(`Running tool activity ${entry.key} has no result`);
    return result;
  }

  private resultView(entry: ToolActivityEntry): ToolActivityResultView {
    if (entry.status !== 'running') return toolActivityResultView(entry);
    if (this.committedOutput) {
      const result = classifyToolResult(entry.output + (this.previews.get(entry.key) ?? ''));
      // 読み切れていない JSON は、完了して分類できるまで表示しない（main と同じ）。
      return { text: result.kind !== 'text' ? '' : result.text, sensitiveValues: createBoundedSensitiveValues() };
    }
    const preview = this.runningResult(entry).preview(entry);
    return { ...preview, text: withoutHeldTail(preview.text) };
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
    return { ...projectToolActivity(entry, 'expanded', view),
      result: toolActivityDetail(entry, offset, undefined, undefined, view) };
  }

  flush(): void {
    if (this.mode === 'silent') return;
    for (const entry of this.history.entries()) {
      if (entry.status !== 'running') continue;
      if (this.mode === 'expanded' && entry.output !== '') {
        const classified = classifyToolResult(entry.output);
        const value = projectToolActivity(entry, 'expanded', classified.kind === 'structured' ? undefined : this.runningResult(entry).preview(entry));
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
      headerTool: projectLabel(tool || entry.tool, this.resultView(entry).sensitiveValues), consumed: 0, previewed: '',
    };
  }

  private stream(entry: ToolActivityEntry, tool: string): void {
    let state = this.streams.get(entry.key);
    if (state === undefined) {
      state = this.newStream(entry, tool);
      this.streams.set(entry.key, state);
    }
    const result = classifyToolResult(entry.output);
    if (result.kind !== 'text' || state.omitted) return;
    const text = normalizeToolResultText(result.text);
    state.pending += this.unpreviewed(state, state.redactor.write(text.slice(state.consumed), toolResultSensitiveValues(entry.input)));
    state.consumed = text.length;
    this.drain(state, false);
  }

  /** flush で仮に表示した部分は、確定したときに表示し直さない。 */
  private unpreviewed(state: StreamOutputState, committed: string): string {
    if (state.previewed === '' || committed === '') return committed;
    const previewed = state.previewed;
    state.previewed = '';
    return unprinted(previewed, committed);
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
    const result = classifyToolResult(entry.output);
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
    const source = toolResultSensitiveValues(entry.input);
    const text = normalizeToolResultText(result.text);
    const written = state.redactor.write(text.slice(state.consumed), source);
    state.consumed = text.length;
    if (entry.status === 'running') {
      // 改行の来ていない行は確定させず、マスクした仮の表示だけを出す。
      state.pending += this.unpreviewed(state, written);
      const preview = state.redactor.preview(source);
      state.pending += unprinted(state.previewed, preview);
      state.previewed = preview;
    } else {
      state.pending += this.unpreviewed(state, written + state.redactor.flush(source));
    }
    this.drain(state, true);
  }

  private complete(entry: ToolActivityEntry): void {
    if (this.completed.get(entry.key) === entry.status) return;
    this.completed.set(entry.key, entry.status);
    if (this.mode === 'compact') this.flushStream(entry);
    const mode = this.mode === 'expanded' ? 'expanded' : 'compact';
    const value = projectToolActivity(entry, mode, this.resultView(entry));
    const failed = value.status === 'failure';
    if (this.mode === 'compact' && this.quiet && !failed) return;
    const name = this.mode === 'compact' && this.quiet ? 'Tool' : value.tool;
    const symbol = failed ? '✗' : '✓';
    const suppressed = entry.tool === 'AskUserQuestion' && !failed;
    if (this.mode === 'expanded') {
      const duration = value.durationMs === undefined ? '' : ` (${value.durationMs} ms)`;
      this.writeLine(`  ${symbol} ${name} ${value.action} ${value.input}${duration} [${value.status}]`);
      if (!suppressed) this.writeExpandedResult(value);
    } else {
      const state = this.streams.get(entry.key);
      const alreadyPrinted = state?.printed.replace(/\n$/u, '') === value.result.text;
      const firstLine = value.result.text.split('\n', 1)[0] ?? '';
      const preview = suppressed || alreadyPrinted ? '' : truncate(firstLine || (failed ? 'Unknown error' : ''), failed ? 70 : 60);
      this.writeLine(`  ${symbol} ${name}${failed ? ':' : ''}${preview === '' ? '' : ` ${preview}`}`);
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
    const remaining = unprinted(previous.text, value.result.text);
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
