import type { StreamEvent } from '../types/provider.js';
import { ToolActivityHistory } from '../tool-activity/history.js';
import { classifyToolResult } from '../tool-activity/result.js';
import { normalizeToolResultText, toolResultSensitiveValues } from '../tool-activity/sanitize.js';
import { CI_RESULT_BYTES, CI_RESULT_LINES, COMPACT_RESULT_BYTES, COMPACT_RESULT_LINES, groupToolActivities, projectToolActivity, toolActivityDetail } from '../tool-activity/presentation.js';
import type { ToolActivityDisplayMode, ToolActivityEntry, ToolActivityGroup, ToolActivityHistoryState, ToolActivityProjection } from '../tool-activity/types.js';
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
  consumed: number;
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
  private readonly readableStreams = new Map<string, { redactor: SensitiveTextStreamRedactor; consumed: number; text: string }>();

  constructor(
    readonly mode: ToolActivityDisplayMode,
    private readonly quiet: boolean,
    private readonly writeLine: (text: string) => void,
    private readonly showCompactStarts: boolean,
  ) {}

  handle(event: StreamEvent): ToolActivityEntry[] {
    const entries = this.history.apply(event);
    if (event.type === 'tool_output') {
      for (const entry of entries) {
        const result = classifyToolResult(entry.output);
        if (result.kind !== 'text') continue;
        let stream = this.readableStreams.get(entry.key);
        if (stream === undefined) {
          stream = { redactor: createSensitiveTextStreamRedactor(), consumed: 0, text: '' };
          this.readableStreams.set(entry.key, stream);
        }
        const text = normalizeToolResultText(result.text);
        stream.text += stream.redactor.write(text.slice(stream.consumed), toolResultSensitiveValues(entry.input));
        stream.consumed = text.length;
      }
    }
    if (event.type === 'tool_result') {
      for (const entry of entries) this.readableStreams.delete(entry.key);
    }
    if (this.mode === 'silent') return entries;
    for (const entry of entries) {
      if (event.type === 'tool_use') {
        if (this.mode === 'expanded' || (this.showCompactStarts && !this.quiet)) {
          const value = projectToolActivity(entry, this.mode);
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

  restore(state: ToolActivityHistoryState): void {
    this.history.restore(state);
    this.streams.clear();
    this.completed.clear();
    this.displayedResults.clear();
    this.readableStreams.clear();
    for (const entry of this.history.entries()) {
      if (entry.status !== 'running') {
        this.completed.set(entry.key, entry.status);
        continue;
      }
      const result = classifyToolResult(entry.output);
      if (result.kind !== 'text') continue;
      const redactor = createSensitiveTextStreamRedactor();
      const normalized = normalizeToolResultText(result.text);
      const text = redactor.write(normalized, toolResultSensitiveValues(entry.input));
      this.readableStreams.set(entry.key, { redactor, consumed: normalized.length, text });
    }
  }

  groups(): ToolActivityGroup[] {
    const entries = this.history.entries();
    return groupToolActivities(entries, this.readableResults(entries));
  }

  detail(key: string, offset: number): ToolActivityProjection {
    const entry = this.history.get(key);
    if (entry === undefined) throw new RangeError('Unknown tool activity key');
    const text = this.readableResults([entry]).get(entry.key);
    return { ...projectToolActivity(entry, 'expanded', text), result: toolActivityDetail(entry, offset, undefined, undefined, text) };
  }

  private readableResults(entries: readonly ToolActivityEntry[]): ReadonlyMap<string, string> {
    const results = new Map<string, string>();
    for (const entry of entries) {
      if (entry.status !== 'running') continue;
      // 構造化出力は、最終結果だけが持つ秘密値の情報が揃うまで公開しない。
      const text = classifyToolResult(entry.output).kind === 'structured' ? ''
        : this.readableStreams.get(entry.key)?.text ?? '';
      results.set(entry.key, text);
    }
    return results;
  }

  flush(): void {
    if (this.mode === 'silent') return;
    for (const entry of this.history.entries()) {
      if (entry.status !== 'running') continue;
      if (this.mode === 'expanded' && entry.output !== '') {
        const source = toolResultSensitiveValues(entry.input);
        const isReadableText = classifyToolResult(entry.output).kind === 'text';
        const hasSafeSource = source.exhausted || source.values.size > 0;
        const stream = this.readableStreams.get(entry.key);
        if (isReadableText && hasSafeSource && stream !== undefined) {
          stream.text += stream.redactor.flushAvailable(source);
        }
        const text = isReadableText && hasSafeSource ? stream?.text ?? '' : undefined;
        const value = projectToolActivity(entry, 'expanded', text);
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
      headerTool: projectToolActivity({ ...entry, tool: tool || entry.tool }).tool, consumed: 0,
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
    state.pending += state.redactor.write(text.slice(state.consumed), toolResultSensitiveValues(entry.input));
    state.consumed = text.length;
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
    state.pending += entry.status === 'running'
      ? state.redactor.flushAvailable(source)
      : state.redactor.flush(source);
    this.drain(state, true);
  }

  private complete(entry: ToolActivityEntry): void {
    if (this.completed.get(entry.key) === entry.status) return;
    this.completed.set(entry.key, entry.status);
    if (this.mode === 'compact') this.flushStream(entry);
    const value = projectToolActivity(entry, this.mode === 'expanded' ? 'expanded' : 'compact');
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
