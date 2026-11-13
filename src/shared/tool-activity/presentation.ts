import {
  createBoundedSensitiveValues,
  sanitizeSensitiveTextWithKnownValues,
} from '../utils/sensitiveText.js';
import { sanitizeTerminalStreamText, sanitizeTerminalText } from '../utils/text.js';
import type { ToolActivityEntry, ToolActivityGroup, ToolActivityPage, ToolActivityProjection } from './types.js';
import { classifyToolResult } from './result.js';
import { sanitizeToolResultText, toolResultSensitiveValues } from './sanitize.js';

export const COMPACT_RESULT_LINES = 3;
export const COMPACT_RESULT_BYTES = 1024;
export const COMPACT_INPUT_BYTES = 256;
export const DETAIL_RESULT_LINES = 40;
export const DETAIL_RESULT_BYTES = 16 * 1024;
export const CI_RESULT_LINES = 80;
export const CI_RESULT_BYTES = 16 * 1024;
const INPUT_TRUNCATION_MARKER = ' [input truncated]';
const NAME_TRUNCATION_MARKER = ' [name truncated]';

export function formatToolActivityTime(epochMs: number): string {
  const time = new Date(epochMs);
  return [time.getHours(), time.getMinutes(), time.getSeconds()].map((value) => String(value).padStart(2, '0')).join(':');
}

function canonicalToolName(tool: string): string {
  switch (tool.toLowerCase()) {
    case 'bash': return 'Bash';
    case 'read': return 'Read';
    case 'write': return 'Write';
    case 'edit': return 'Edit';
    case 'grep': return 'Grep';
    case 'glob': return 'Glob';
    default: return tool;
  }
}

function stringInput(input: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (Object.hasOwn(input, key) && typeof value === 'string') return value;
  }
  return undefined;
}

function selectedInput(tool: string, input: Record<string, unknown>): string {
  switch (canonicalToolName(tool)) {
    case 'Bash': return stringInput(input, ['command']) ?? '';
    case 'Read': case 'Write': case 'Edit': return stringInput(input, ['file_path', 'filePath', 'path']) ?? '';
    case 'Grep': case 'Glob': return stringInput(input, ['pattern']) ?? '';
    default: {
      const selected = stringInput(input, ['query', 'input', 'command', 'file_path', 'filePath', 'pattern', 'path']);
      if (selected !== undefined) return selected;
      // 未知のツールは、入力の最初の値を要約として見せる。
      const firstKey = Object.keys(input)[0];
      return firstKey === undefined ? '' : String(input[firstKey] || '');
    }
  }
}

export function projectToolInput(tool: string, input: Record<string, unknown>, source: unknown = input): string {
  const terminalSafeInput = sanitizeTerminalStreamText(selectedInput(tool, input));
  return sanitizeTerminalStreamText(sanitizeSensitiveTextWithKnownValues(terminalSafeInput, source));
}

function action(tool: string): string {
  switch (canonicalToolName(tool)) {
    case 'Bash': return 'Ran';
    case 'Grep': return 'Used Grep';
    default: return canonicalToolName(tool);
  }
}

function displayResult(entry: ToolActivityEntry, resultText?: string): { text: string; source: unknown } {
  const raw = entry.result === undefined || entry.result === '' ? entry.output : entry.result;
  const { text, parsed } = classifyToolResult(raw, entry.status !== 'running');
  const known = createBoundedSensitiveValues();
  known.collect(entry.input);
  known.collect(raw);
  known.collect(entry.output);
  known.collect(parsed);
  // resultText は ToolActivityDisplay が追記分ごとに正規化済みなので、描画のたびに全体を正規化し直さない。
  const sanitized = resultText === undefined ? sanitizeToolResultText(text, known)
    : sanitizeSensitiveTextWithKnownValues(resultText, toolResultSensitiveValues(known));
  return { text: sanitized, source: known };
}

export function toolActivityDetail(
  entry: ToolActivityEntry,
  offset = 0,
  maxLines = DETAIL_RESULT_LINES,
  maxBytes = DETAIL_RESULT_BYTES,
  resultText?: string,
): ToolActivityPage {
  if (!Number.isInteger(offset) || offset < 0
    || !Number.isInteger(maxLines) || maxLines < 1
    || !Number.isInteger(maxBytes) || maxBytes < 4) throw new RangeError('Invalid tool activity page bounds');
  const { text } = displayResult(entry, resultText);
  return textPage(text, offset, Math.min(maxLines, DETAIL_RESULT_LINES), Math.min(maxBytes, DETAIL_RESULT_BYTES));
}

function textPage(text: string, offset: number, maxLines: number, maxBytes: number): ToolActivityPage {
  const begin = Math.min(offset, text.length);
  let end = begin;
  let bytes = 0;
  let lines = 0;
  while (end < text.length) {
    const char = String.fromCodePoint(text.codePointAt(end)!);
    const size = Buffer.byteLength(char, 'utf8');
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += char.length;
    if (char === '\n' && ++lines >= maxLines) break;
  }
  return {
    text: text.slice(begin, end).replace(/\n$/u, ''), nextOffset: end,
    hasMore: end < text.length, truncated: end < text.length,
  };
}

function projectLabel(text: string, source: unknown): string {
  const safe = sanitizeTerminalText(sanitizeSensitiveTextWithKnownValues(text, source));
  const page = textPage(safe, 0, 1, COMPACT_INPUT_BYTES - Buffer.byteLength(NAME_TRUNCATION_MARKER));
  return page.text + (page.truncated ? NAME_TRUNCATION_MARKER : '');
}

export function projectToolActivity(entry: ToolActivityEntry, mode: 'compact' | 'expanded' = 'compact', resultText?: string): ToolActivityProjection {
  const { text, source } = displayResult(entry, resultText);
  const inputBytes = mode === 'compact' ? COMPACT_INPUT_BYTES : DETAIL_RESULT_BYTES;
  const input = textPage(projectToolInput(entry.tool, entry.input, source), 0,
    mode === 'compact' ? 1 : DETAIL_RESULT_LINES,
    inputBytes - Buffer.byteLength(INPUT_TRUNCATION_MARKER));
  return {
    key: entry.key, tool: projectLabel(entry.tool, source),
    action: projectLabel(action(entry.tool), source),
    input: input.text + (input.truncated ? INPUT_TRUNCATION_MARKER : ''), status: entry.status,
    startedAt: entry.startedAt, completedAt: entry.completedAt,
    startSequence: entry.startSequence, completionSequence: entry.completionSequence,
    durationMs: entry.startedAt === undefined || entry.completedAt === undefined
      ? undefined : Math.max(0, entry.completedAt - entry.startedAt),
    result: textPage(text, 0,
      mode === 'compact' ? COMPACT_RESULT_LINES : CI_RESULT_LINES,
      mode === 'compact' ? COMPACT_RESULT_BYTES : CI_RESULT_BYTES),
  };
}

export function groupToolActivities(entries: readonly ToolActivityEntry[], resultTexts?: ReadonlyMap<string, string>): ToolActivityGroup[] {
  const groups: ToolActivityGroup[] = [];
  let previousTool: string | undefined;
  for (const entry of entries) {
    const projection = projectToolActivity(entry, 'compact', resultTexts?.get(entry.key));
    const previous = groups.at(-1);
    const tool = canonicalToolName(entry.tool);
    if (previous !== undefined && previousTool === tool) previous.entries.push(projection);
    else groups.push({ summary: projection.action, entries: [projection] });
    previousTool = tool;
  }
  for (const group of groups) {
    if (group.entries.length > 1) group.summary = `${group.entries[0]!.action} ${group.entries.length}${canonicalToolName(group.entries[0]!.tool) === 'Read' ? ' files' : ' operations'}`;
  }
  return groups;
}
