import { Buffer } from 'node:buffer';

export const COMPANION_OUTPUT_LIMITS = {
  maxArrayItems: 50,
  maxStringBytes: 16 * 1024,
  maxSerializedBytes: 64 * 1024,
} as const;

export function assertCompanionOutputEnvelope(value: unknown): void {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error('Companion structured output must be JSON serializable');
  }
  if (Buffer.byteLength(serialized, 'utf8') > COMPANION_OUTPUT_LIMITS.maxSerializedBytes) {
    throw new Error('Companion structured output exceeds the serialized byte limit');
  }
  assertBoundedValue(value);
}

function assertBoundedValue(value: unknown): void {
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > COMPANION_OUTPUT_LIMITS.maxStringBytes) {
      throw new Error('Companion structured output string exceeds the byte limit');
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > COMPANION_OUTPUT_LIMITS.maxArrayItems) {
      throw new Error('Companion structured output array exceeds the item limit');
    }
    for (const item of value) assertBoundedValue(item);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const nested of Object.values(value)) assertBoundedValue(nested);
}
