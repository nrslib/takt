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

export function parseJsonLines(stdout: string, providerName: string): unknown[] {
  const lines = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    throw new Error(`${providerName} returned empty output`);
  }

  return lines.map((line, index) => {
    try {
      return JSON.parse(line) as unknown;
    } catch {
      throw new Error(`Failed to parse ${providerName} JSONL output at line ${index + 1}`);
    }
  });
}

export function emitStructuredEvents(
  onStream: StreamCallback | undefined,
  events: readonly StreamEvent[],
): void {
  for (const event of events) {
    onStream?.(event);
  }
}
