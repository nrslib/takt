import type { StreamCallback, StreamEvent } from '../shared/types/provider.js';

export function toRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function firstNonEmptyString(values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

export function extractStructuredText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value.length > 0 ? value : undefined;
  }

  if (Array.isArray(value)) {
    const parts = value
      .map((entry) => extractStructuredText(entry))
      .filter((entry): entry is string => entry !== undefined && entry.length > 0);
    return parts.length > 0 ? parts.join('\n') : undefined;
  }

  const record = toRecord(value);
  if (record === undefined) {
    return undefined;
  }

  const direct = firstNonEmptyString([record.text, record.data]);
  if (direct !== undefined) {
    return direct;
  }

  for (const key of ['content', 'contents', 'output', 'result'] as const) {
    const nested = extractStructuredText(record[key]);
    if (nested !== undefined) {
      return nested;
    }
  }

  return undefined;
}

export function parseValidJsonLines(stdout: string): unknown[] {
  const lines: unknown[] = [];
  for (const line of stdout.split(/\r?\n/u)) {
    try {
      lines.push(JSON.parse(line) as unknown);
    } catch {
      // CLIs may print banners or warnings alongside structured events.
    }
  }
  return lines;
}

export function emitStructuredEvents(
  onStream: StreamCallback | undefined,
  events: readonly StreamEvent[],
): void {
  for (const event of events) {
    onStream?.(event);
  }
}
