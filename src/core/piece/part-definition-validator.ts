import type { PartDefinition } from '../models/part.js';

function assertNonEmptyString(value: unknown, fieldName: string, index: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Part[${index}] "${fieldName}" must be a non-empty string`);
  }
  return value;
}

export function parsePartDefinitionEntry(entry: unknown, index: number): PartDefinition {
  if (typeof entry !== 'object' || entry == null || Array.isArray(entry)) {
    throw new Error(`Part[${index}] must be an object`);
  }

  const raw = entry as Record<string, unknown>;
  const id = assertNonEmptyString(raw.id, 'id', index);
  const title = assertNonEmptyString(raw.title, 'title', index);
  const instruction = assertNonEmptyString(raw.instruction, 'instruction', index);

  const timeoutMsValue = raw.timeout_ms;
  if (timeoutMsValue != null && (typeof timeoutMsValue !== 'number' || !Number.isInteger(timeoutMsValue) || timeoutMsValue <= 0)) {
    throw new Error(`Part[${index}] "timeout_ms" must be a positive integer`);
  }
  const timeoutMs = timeoutMsValue == null ? undefined : timeoutMsValue;

  return {
    id,
    title,
    instruction,
    timeoutMs,
  };
}

export function ensureUniquePartIds(parts: PartDefinition[]): void {
  const ids = new Set<string>();
  for (const part of parts) {
    if (ids.has(part.id)) {
      throw new Error(`Duplicate part id: ${part.id}`);
    }
    ids.add(part.id);
  }
}
