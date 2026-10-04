import { createHash } from 'node:crypto';

export type ToolTerminalOutcome = 'success' | 'failure';

export interface ToolTerminalTuple {
  tool: string;
  outcome: ToolTerminalOutcome;
  inputHash: string;
  resultHash: string;
  identityKey: string;
  key: string;
}

type CanonicalizationResult =
  | { ok: true; value: string }
  | { ok: false };

function canonicalize(value: unknown, ancestors: Set<object>): CanonicalizationResult {
  if (value === null) return { ok: true, value: 'null' };
  if (typeof value === 'string' || typeof value === 'boolean') {
    return { ok: true, value: JSON.stringify(value) };
  }
  if (typeof value === 'number') {
    return Number.isFinite(value)
      ? { ok: true, value: Object.is(value, -0) ? '0' : String(value) }
      : { ok: false };
  }
  if (typeof value !== 'object') return { ok: false };
  if (ancestors.has(value)) return { ok: false };

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (const item of value) {
        const serialized = canonicalize(item, ancestors);
        if (!serialized.ok) return serialized;
        items.push(serialized.value);
      }
      return { ok: true, value: `[${items.join(',')}]` };
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return { ok: false };
    const record = value as Record<string, unknown>;
    const properties: string[] = [];
    for (const key of Object.keys(record).sort()) {
      const serialized = canonicalize(record[key], ancestors);
      if (!serialized.ok) return serialized;
      properties.push(`${JSON.stringify(key)}:${serialized.value}`);
    }
    return { ok: true, value: `{${properties.join(',')}}` };
  } finally {
    ancestors.delete(value);
  }
}

function computeDomainSeparatedHash(domain: string, value: unknown): string | undefined {
  const serialized = canonicalize(value, new Set<object>());
  if (!serialized.ok) return undefined;
  return createHash('sha256')
    .update(domain)
    .update('\0')
    .update(serialized.value)
    .digest('hex');
}

export function computeToolInputHash(input: unknown): string | undefined {
  return computeDomainSeparatedHash('takt.opencode.tool-input.v1', input);
}

export function computeToolResultHash(result: unknown): string | undefined {
  return computeDomainSeparatedHash('takt.opencode.tool-result.v1', result);
}

export function createToolTerminalTupleFromHashes(
  tool: string,
  outcome: ToolTerminalOutcome,
  inputHash: string,
  resultHash: string,
): ToolTerminalTuple {
  const normalizedTool = tool.trim().toLowerCase();
  return {
    tool,
    outcome,
    inputHash,
    resultHash,
    identityKey: `${tool}\0${outcome}\0${inputHash}\0${resultHash}`,
    key: `${normalizedTool}\0${outcome}\0${inputHash}\0${resultHash}`,
  };
}

export function createToolTerminalTuple(
  tool: string,
  outcome: ToolTerminalOutcome,
  input: unknown,
  result: unknown,
): ToolTerminalTuple | undefined {
  const inputHash = computeToolInputHash(input);
  const resultHash = computeToolResultHash(result);
  if (inputHash === undefined || resultHash === undefined) return undefined;
  return createToolTerminalTupleFromHashes(tool, outcome, inputHash, resultHash);
}
