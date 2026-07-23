import { createHash } from 'node:crypto';

function serializeCanonicalJson(value: unknown, ancestors: Set<object>): string {
  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      throw new TypeError('Cannot canonicalize cyclic JSON content');
    }
    ancestors.add(value);
    const serialized = `[${value.map((item) => (
      item === undefined || typeof item === 'function' || typeof item === 'symbol'
        ? 'null'
        : serializeCanonicalJson(item, ancestors)
    )).join(',')}]`;
    ancestors.delete(value);
    return serialized;
  }
  if (value !== null && typeof value === 'object') {
    if (ancestors.has(value)) {
      throw new TypeError('Cannot canonicalize cyclic JSON content');
    }
    ancestors.add(value);
    const serialized = `{${Object.getOwnPropertyNames(value)
      .map((key) => [key, (value as Record<string, unknown>)[key]] as const)
      .filter(([, item]) => item !== undefined && typeof item !== 'function' && typeof item !== 'symbol')
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${serializeCanonicalJson(item, ancestors)}`)
      .join(',')}}`;
    ancestors.delete(value);
    return serialized;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError('Value cannot be represented as canonical JSON');
  }
  return serialized;
}

function canonicalJson(value: unknown): string {
  return serializeCanonicalJson(value, new Set());
}

export function hashCanonicalJson(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
