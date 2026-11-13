import { REDACTED_VALUE, openSensitiveValueLineStart, sanitizeTextWithValues } from './sensitive-text.js';
import { collectSensitiveStringValues } from './sensitive-value.js';

const MAX_PENDING_SENSITIVE_TEXT_LENGTH = 10_000;

export interface SensitiveTextStreamRedactor {
  write(text: string, source: unknown): string;
  flush(source: unknown): string;
}

/** 複数行にわたる既知の秘密値と、値の途中にある改行の位置。 */
interface MultiLineValue {
  readonly value: string;
  readonly newlines: readonly number[];
}

function multiLineValue(value: string): MultiLineValue | undefined {
  const newlines = [...value.matchAll(/\n/g)].map((match) => match.index).filter((index) => index < value.length - 1);
  return newlines.length === 0 ? undefined : { value, newlines };
}

/**
 * 複数行にわたる既知の秘密値の先頭の行が末尾にあれば、その値の位置を返す。
 * 値の続きは次の行で届くので、先頭の行だけを確定すると、値全体の一致では伏せられない。
 */
function knownMultiLineValueStart(text: string, values: readonly MultiLineValue[]): number | undefined {
  let start: number | undefined;
  for (const { value, newlines } of values) {
    for (const newline of newlines) {
      if (text.endsWith(value.slice(0, newline + 1))) start = Math.min(start ?? text.length, text.length - newline - 1);
    }
  }
  return start;
}

/** 確定してよい長さ。改行で終わった完全な行のうち、改行をまたいで続く秘密値の行より前まで。 */
function committableLength(text: string, values: readonly MultiLineValue[]): number {
  const complete = text.slice(0, text.lastIndexOf('\n') + 1);
  if (complete === '') return 0;
  return openSensitiveValueLineStart(complete, knownMultiLineValueStart(complete, values)) ?? complete.length;
}

/**
 * 追記を保留し、改行で終わった完全な行だけを、確定する範囲ごとにまとめてマスクして返す。
 * 行の途中で確定すると、値の後半はキー名のない文字列になり伏せられないため。
 * 改行のないまま保留が上限を超えたら、以後の出力はすべて伏せる。
 */
export function createSensitiveTextStreamRedactor(): SensitiveTextStreamRedactor {
  const knownValues = new Set<string>();
  const multiLineValues: MultiLineValue[] = [];
  let pending = '';
  let failClosed = false;

  const updateKnownValues = (source: unknown): void => {
    const collected = collectSensitiveStringValues(source);
    failClosed ||= collected.exhausted;
    for (const value of collected.values) {
      if (knownValues.has(value)) continue;
      knownValues.add(value);
      const multiLine = multiLineValue(value);
      if (multiLine !== undefined) multiLineValues.push(multiLine);
    }
  };

  const redactPending = (): string => {
    const hadPendingText = pending.length > 0;
    pending = '';
    return hadPendingText ? REDACTED_VALUE : '';
  };

  return {
    write(text: string, source: unknown): string {
      updateKnownValues(source);
      pending += text;
      if (failClosed) return redactPending();
      const end = committableLength(pending, multiLineValues);
      const committed = pending.slice(0, end);
      pending = pending.slice(end);
      const output = committed === '' ? '' : sanitizeTextWithValues(committed, knownValues);
      if (pending.length <= MAX_PENDING_SENSITIVE_TEXT_LENGTH) return output;
      failClosed = true;
      return output + redactPending();
    },
    flush(source: unknown): string {
      updateKnownValues(source);
      if (failClosed) return redactPending();
      const text = pending;
      pending = '';
      return text === '' ? '' : sanitizeTextWithValues(text, knownValues);
    },
  };
}
