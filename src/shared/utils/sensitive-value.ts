import {
  REDACTED_VALUE,
  addSensitiveValue,
  collectEmbeddedSensitiveValues,
  isSensitiveKeyName,
  sanitizeTextWithValues,
} from './sensitive-text.js';

const MAX_SENSITIVE_VALUE_NODES = 10_000;
export const MAX_TRACKED_SENSITIVE_VALUES = 1_024;
export const MAX_TRACKED_SENSITIVE_VALUE_BYTES = 1024 * 1024;
export const MAX_INSPECTED_BYTES_PER_SOURCE = 16 * 1024 * 1024;

export interface SensitiveValues {
  values: Set<string>;
  exhausted: boolean;
  inspectedBytes: number;
}

/**
 * 予算超過の理由。挙動はいずれも同じ exhaust（fail-closed）だが、
 * 誤爆調査のためにどの上限に当たったかを失敗メッセージへ残す。
 */
export type SensitiveBudgetExhaustReason =
  | 'candidate_count'
  | 'candidate_bytes'
  | 'source_scan';

/**
 * 予算は「検査した量」ではなく「保持している機密候補」に課金する。
 * 検査量課金だと Write/Edit 本文のような非機密の大きな入力が予算を食い潰し、
 * 健全な長時間実行が fail-closed に到達してしまう（実測で発生）。
 * 保持候補への課金なら、予算超過 = 実際に大量の機密候補を追跡できなくなった
 * ときだけであり、そのときの exhaust（以降すべて [REDACTED]）は漏洩防止として正当。
 * 単一ソースの検査上限（バイト・ノード数）は、走査コストとフラット化攻撃への
 * 防護として別途残す。
 */
export class BoundedSensitiveValues {
  readonly values = new Set<string>();
  exhausted = false;
  exhaustReason: SensitiveBudgetExhaustReason | undefined;
  storedValueBytes = 0;

  collect(source: unknown): void {
    if (this.exhausted) {
      return;
    }
    const collected = collectSensitiveStringValues(source, MAX_INSPECTED_BYTES_PER_SOURCE);
    if (collected.exhausted) {
      this.exhaust('source_scan');
      return;
    }
    for (const value of collected.values) {
      if (this.values.has(value)) {
        continue;
      }
      this.values.add(value);
      this.storedValueBytes += Buffer.byteLength(value, 'utf8');
    }
    if (this.values.size > MAX_TRACKED_SENSITIVE_VALUES) {
      this.exhaust('candidate_count');
      return;
    }
    if (this.storedValueBytes > MAX_TRACKED_SENSITIVE_VALUE_BYTES) {
      this.exhaust('candidate_bytes');
    }
  }

  reset(): void {
    this.values.clear();
    this.exhausted = false;
    this.exhaustReason = undefined;
    this.storedValueBytes = 0;
  }

  exhaust(reason?: SensitiveBudgetExhaustReason): void {
    this.values.clear();
    this.exhausted = true;
    if (reason !== undefined && this.exhaustReason === undefined) {
      this.exhaustReason = reason;
    }
  }
}

export function createBoundedSensitiveValues(): BoundedSensitiveValues {
  return new BoundedSensitiveValues();
}

interface ValueWorkItem {
  value: unknown;
  key?: string;
  sensitiveContext: boolean;
}

interface SanitizeWorkItem {
  value: unknown;
  key?: string;
  target: Record<string, unknown> | unknown[];
  targetKey: string | number;
}

type ValueEntry = readonly [string, unknown];

export interface SensitiveStringReplacement {
  readonly value: unknown;
}

export type SensitiveStringReplacer = (
  value: string,
  key: string | undefined,
) => SensitiveStringReplacement | undefined;

export function sanitizeSensitiveValue(value: unknown, key?: string): unknown {
  return sanitizeValue(value, key, new Set(), false, undefined);
}

export function sanitizeSensitiveValueWithStringReplacer(
  value: unknown,
  replacer: SensitiveStringReplacer,
): unknown {
  const sensitiveValues = collectSensitiveStringValues(value);
  return sanitizeValue(
    value,
    undefined,
    sensitiveValues.values,
    sensitiveValues.exhausted,
    replacer,
  );
}

export function sanitizeSensitiveValueWithKnownValues(
  value: unknown,
  source: unknown,
  key?: string,
): unknown {
  const sensitiveValues = collectSensitiveStringValues(source);
  return sanitizeValue(
    value,
    key,
    sensitiveValues.values,
    sensitiveValues.exhausted,
    undefined,
  );
}

export function sanitizeSensitiveTextWithKnownValues(text: string, source: unknown): string {
  const sensitiveValues = collectSensitiveStringValues(source);
  if (sensitiveValues.exhausted) {
    return text.length === 0 ? text : REDACTED_VALUE;
  }
  return sanitizeTextWithValues(text, sensitiveValues.values);
}

function sanitizeValue(
  value: unknown,
  key: string | undefined,
  knownValues: ReadonlySet<string>,
  redactAllStrings: boolean,
  stringReplacer: SensitiveStringReplacer | undefined,
): unknown {
  const holder: Record<string, unknown> = {};
  const work: SanitizeWorkItem[] = [{ value, key, target: holder, targetKey: 'value' }];
  const seen = new WeakSet<object>();
  let visitedNodes = 0;

  while (work.length > 0) {
    const item = work.pop()!;
    visitedNodes += 1;
    if (item.key !== undefined && isSensitiveKeyName(item.key)) {
      assignSanitized(item.target, item.targetKey, REDACTED_VALUE);
      continue;
    }
    if (typeof item.value === 'string') {
      const replacement = stringReplacer?.(item.value, item.key);
      assignSanitized(
        item.target,
        item.targetKey,
        replacement !== undefined
          ? replacement.value
          : redactAllStrings && item.value.length > 0
          ? REDACTED_VALUE
          : sanitizeTextWithValues(item.value, knownValues),
      );
      continue;
    }
    if (item.value === null || typeof item.value !== 'object') {
      assignSanitized(item.target, item.targetKey, item.value);
      continue;
    }
    if (seen.has(item.value)) {
      assignSanitized(item.target, item.targetKey, REDACTED_VALUE);
      continue;
    }
    const entries = boundedEntries(
      item.value,
      MAX_SENSITIVE_VALUE_NODES - visitedNodes - work.length,
    );
    if (entries === undefined) {
      assignSanitized(item.target, item.targetKey, REDACTED_VALUE);
      continue;
    }
    seen.add(item.value);
    const valueIsArray = Array.isArray(item.value);
    const output: Record<string, unknown> | unknown[] = valueIsArray
      ? new Array((item.value as unknown[]).length)
      : {};
    assignSanitized(item.target, item.targetKey, output);
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const [entryKey, entryValue] = entries[index]!;
      work.push({
        value: entryValue,
        key: valueIsArray ? undefined : entryKey,
        target: output,
        targetKey: valueIsArray ? Number(entryKey) : entryKey,
      });
    }
  }
  return holder['value'];
}

export function collectSensitiveStringValues(
  source: unknown,
  maxInspectedBytes = Number.POSITIVE_INFINITY,
): SensitiveValues {
  if (source instanceof BoundedSensitiveValues) {
    return {
      values: new Set(source.values),
      exhausted: source.exhausted,
      inspectedBytes: 0,
    };
  }
  const result: SensitiveValues = { values: new Set(), exhausted: false, inspectedBytes: 0 };
  const work: ValueWorkItem[] = [{ value: source, sensitiveContext: false }];
  const seen = new WeakSet<object>();
  let visitedNodes = 0;

  while (work.length > 0) {
    const item = work.pop()!;
    visitedNodes += 1;
    const sensitiveContext = item.sensitiveContext
      || (item.key !== undefined && isSensitiveKeyName(item.key));
    if (item.key !== undefined) {
      result.inspectedBytes += Buffer.byteLength(item.key);
    }
    if (typeof item.value === 'string') {
      result.inspectedBytes += Buffer.byteLength(item.value);
      if (result.inspectedBytes > maxInspectedBytes) {
        result.exhausted = true;
        break;
      }
      if (sensitiveContext) {
        addSensitiveValue(result.values, item.value, item.key);
      }
      collectEmbeddedSensitiveValues(item.value, result.values);
      continue;
    }
    if (result.inspectedBytes > maxInspectedBytes) {
      result.exhausted = true;
      break;
    }
    if (item.value === null || typeof item.value !== 'object' || seen.has(item.value)) {
      continue;
    }
    const entries = boundedEntries(
      item.value,
      MAX_SENSITIVE_VALUE_NODES - visitedNodes - work.length,
    );
    if (entries === undefined) {
      result.exhausted = true;
      break;
    }
    seen.add(item.value);
    const inheritedSensitiveContext = sensitiveContext;
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const [entryKey, entryValue] = entries[index]!;
      work.push({
        value: entryValue,
        key: Array.isArray(item.value) ? item.key : entryKey,
        sensitiveContext: inheritedSensitiveContext,
      });
    }
  }
  return result;
}

function boundedEntries(value: object, remainingNodes: number): ValueEntry[] | undefined {
  if (remainingNodes < 0) {
    return undefined;
  }
  if (Array.isArray(value) && value.length > remainingNodes) {
    return undefined;
  }
  const entries: ValueEntry[] = [];
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      continue;
    }
    if (entries.length >= remainingNodes) {
      return undefined;
    }
    entries.push([key, (value as Record<string, unknown>)[key]]);
  }
  return entries;
}

function assignSanitized(
  target: Record<string, unknown> | unknown[],
  key: string | number,
  value: unknown,
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}
