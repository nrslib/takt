import { stripAnsi } from '../utils/text.js';

const RESULT_FIELDS = ['stdout', 'stderr', 'output', 'content', 'text', 'message', 'result'] as const;
const LOG_PREFIXES = ['[DEBUG]', '[INFO]', '[WARN]', '[ERROR]'];
const OMITTED = '[structured output omitted]';

interface ToolResult {
  kind: 'pending' | 'text' | 'structured';
  text: string;
  parsed?: unknown;
}

// 分割されたANSI列は、次のチャンクで確定するまで文字列処理へ渡さない。
export function classifyToolResult(raw: string): ToolResult {
  // eslint-disable-next-line no-control-regex
  const incompleteEscape = /\x1b(?:\[[0-9;]*|\][^\x07\x1b]*(?:\x1b)?|)$/u.exec(raw);
  const stable = incompleteEscape === null ? raw : raw.slice(0, incompleteEscape.index);
  const normalized = stripAnsi(stable);
  const leading = normalized.trimStart();
  if (leading === '' || LOG_PREFIXES.some((prefix) => prefix.startsWith(leading) && prefix !== leading)) {
    return { kind: 'pending', text: raw.trim() === '' ? '' : OMITTED };
  }
  const structured = leading.startsWith('{') || leading.startsWith('[');
  if (LOG_PREFIXES.some((prefix) => leading.startsWith(prefix)) || !structured) {
    return { kind: 'text', text: stable };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(normalized) as unknown;
  } catch {
    return { kind: 'structured', text: OMITTED };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind: 'structured', text: OMITTED, parsed };
  }
  const record = parsed as Record<string, unknown>;
  const fields = RESULT_FIELDS.flatMap((key): string[] => {
    if (!Object.hasOwn(record, key)) return [];
    const value = record[key];
    if (typeof value === 'string') return [value];
    if (key !== 'content' || !Array.isArray(value)) return [];
    return value.flatMap((block: unknown) => {
      if (block === null || typeof block !== 'object') return [];
      const item = block as Record<string, unknown>;
      return item.type === 'text' && typeof item.text === 'string' ? [item.text] : [];
    });
  });
  return { kind: 'structured', text: fields.length > 0 ? fields.join('\n') : OMITTED, parsed };
}
