import {
  createBoundedSensitiveValues,
  sanitizeSensitiveTextWithKnownValues,
} from '../utils/sensitiveText.js';
import { sanitizeTerminalStreamText, sanitizeTerminalText } from '../utils/text.js';
import type { ToolActivityEntry, ToolActivityGroup, ToolActivityPage, ToolActivityProjection } from './types.js';
import { classifyToolResult } from './result.js';

export const COMPACT_RESULT_LINES = 3;
export const COMPACT_RESULT_BYTES = 1024;
export const COMPACT_INPUT_BYTES = 256;
export const DETAIL_RESULT_LINES = 40;
export const DETAIL_RESULT_BYTES = 16 * 1024;
export const CI_RESULT_LINES = 80;
export const CI_RESULT_BYTES = 16 * 1024;
const INPUT_TRUNCATION_MARKER = ' [input truncated]';
const NAME_TRUNCATION_MARKER = ' [name truncated]';

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

function selectedInput(tool: string, input: Record<string, unknown>): string {
  let keys: readonly string[];
  switch (canonicalToolName(tool)) {
    case 'Bash': keys = ['command']; break;
    case 'Read': case 'Write': case 'Edit': keys = ['file_path', 'filePath', 'path']; break;
    case 'Grep': case 'Glob': keys = ['pattern']; break;
    default: keys = ['query', 'input', 'command', 'file_path', 'filePath', 'pattern', 'path']; break;
  }
  for (const key of keys) {
    if (Object.hasOwn(input, key) && typeof input[key] === 'string') return input[key];
  }
  return '';
}

export function projectToolInput(tool: string, input: Record<string, unknown>, source: unknown = input): string {
  return sanitizeTerminalStreamText(sanitizeSensitiveTextWithKnownValues(selectedInput(tool, input), source));
}

function action(tool: string): string {
  switch (canonicalToolName(tool)) {
    case 'Bash': return 'Ran';
    case 'Grep': return 'Used Grep';
    default: return canonicalToolName(tool);
  }
}

function displayResult(entry: ToolActivityEntry): { text: string; source: unknown } {
  const raw = entry.result === undefined || entry.result === '' ? entry.output : entry.result;
  const { text, parsed } = classifyToolResult(raw);
  const known = createBoundedSensitiveValues();
  known.collect(entry.input);
  known.collect(raw);
  known.collect(entry.output);
  known.collect(parsed);
  return { text: sanitizeTerminalStreamText(sanitizeSensitiveTextWithKnownValues(text, known)), source: known };
}

export function toolActivityDetail(
  entry: ToolActivityEntry,
  offset = 0,
  maxLines = DETAIL_RESULT_LINES,
  maxBytes = DETAIL_RESULT_BYTES,
): ToolActivityPage {
  if (!Number.isInteger(offset) || offset < 0
    || !Number.isInteger(maxLines) || maxLines < 1
    || !Number.isInteger(maxBytes) || maxBytes < 4) throw new RangeError('Invalid tool activity page bounds');
  const { text } = displayResult(entry);
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

export function projectToolActivity(entry: ToolActivityEntry, mode: 'compact' | 'expanded' = 'compact'): ToolActivityProjection {
  const { text, source } = displayResult(entry);
  const inputBytes = mode === 'compact' ? COMPACT_INPUT_BYTES : DETAIL_RESULT_BYTES;
  const input = textPage(projectToolInput(entry.tool, entry.input, source), 0,
    mode === 'compact' ? 1 : DETAIL_RESULT_LINES,
    inputBytes - Buffer.byteLength(INPUT_TRUNCATION_MARKER));
  return {
    key: entry.key, tool: projectLabel(entry.tool, source),
    action: projectLabel(action(entry.tool), source),
    input: input.text + (input.truncated ? INPUT_TRUNCATION_MARKER : ''), status: entry.status,
    startedAt: entry.startedAt, completedAt: entry.completedAt,
    durationMs: entry.startedAt === undefined || entry.completedAt === undefined
      ? undefined : Math.max(0, entry.completedAt - entry.startedAt),
    result: textPage(text, 0,
      mode === 'compact' ? COMPACT_RESULT_LINES : CI_RESULT_LINES,
      mode === 'compact' ? COMPACT_RESULT_BYTES : CI_RESULT_BYTES),
  };
}

export function groupToolActivities(entries: readonly ToolActivityEntry[]): ToolActivityGroup[] {
  const groups: ToolActivityGroup[] = [];
  let previousTool: string | undefined;
  for (const entry of entries) {
    const projection = projectToolActivity(entry);
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
