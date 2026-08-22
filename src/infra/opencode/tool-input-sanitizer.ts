import { createHash } from 'node:crypto';
import { sanitizeSensitiveValueWithStringReplacer } from '../../shared/utils/sensitive-value.js';

const TOOL_CONTENT_INPUT_KEYS = new Map<string, ReadonlySet<string>>([
  ['edit', new Set(['oldstring', 'newstring'])],
  ['write', new Set(['content'])],
  ['apply_patch', new Set(['patchtext'])],
]);

interface ToolContentDescriptor {
  readonly sha256: string;
  readonly length: number;
}

function describeToolContent(value: string): ToolContentDescriptor {
  return {
    sha256: createHash('sha256').update(value).digest('hex').slice(0, 12),
    length: value.length,
  };
}

export function sanitizeOpenCodeToolInput(
  value: Record<string, unknown>,
  tool?: string,
): Record<string, unknown> {
  const toolContentKeys = tool === undefined
    ? undefined
    : TOOL_CONTENT_INPUT_KEYS.get(tool.toLowerCase());
  const sanitized = sanitizeSensitiveValueWithStringReplacer(
    value,
    (text, key) => key !== undefined && toolContentKeys?.has(key.toLowerCase()) === true
      ? { value: describeToolContent(text) }
      : undefined,
  );
  return sanitized !== null && typeof sanitized === 'object' && !Array.isArray(sanitized)
    ? sanitized as Record<string, unknown>
    : { redacted: sanitized };
}

function replaceToolContent(text: string, content: string): string {
  if (content.length === 0 || !text.includes(content)) {
    return text;
  }
  const { sha256, length } = describeToolContent(content);
  const replacement = `{sha256:${sha256},length:${length}}`;
  if (content.length >= 6) {
    return text.split(content).join(replacement);
  }
  const escaped = content.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(
    new RegExp(`(^|[^A-Za-z0-9_])${escaped}(?=$|[^A-Za-z0-9_])`, 'g'),
    `$1${replacement}`,
  );
}

export function maskOpenCodeToolContentInText(
  text: string,
  tool: string,
  input: unknown,
): string {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return text;
  }
  const contentKeys = TOOL_CONTENT_INPUT_KEYS.get(tool.toLowerCase());
  if (contentKeys === undefined) {
    return text;
  }
  let masked = text;
  for (const [key, value] of Object.entries(input)) {
    if (contentKeys.has(key.toLowerCase()) && typeof value === 'string') {
      masked = replaceToolContent(masked, value);
    }
  }
  return masked;
}
