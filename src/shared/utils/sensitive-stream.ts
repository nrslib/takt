import {
  collectEmbeddedSensitiveValues, maskSensitiveRanges, sensitiveTextRanges, substringSensitiveRanges, REDACTED_VALUE,
  type SensitiveRange,
} from './sensitive-text.js';
import { createBoundedSensitiveValues, type BoundedSensitiveValues } from './sensitive-value.js';
import { sliceUtf8 } from './utf8.js';

const PEM_BEGIN = /-----BEGIN ((?:[A-Z0-9]+ )*PRIVATE KEY)-----/u;
const SENSITIVE_PREVIEW_BYTES = 8 * 1024;
const MAX_PENDING_SENSITIVE_LINE_LENGTH = 10_000;

function maskingRanges(text: string, values: BoundedSensitiveValues): SensitiveRange[] {
  const found = new Set<string>();
  collectEmbeddedSensitiveValues(text, found);
  values.collect({ token: [...found] });
  return sensitiveTextRanges(text, values.values);
}

export interface SensitiveTextStreamRedactor {
  /** 渡された秘密値と、出力の中で見つかった秘密値。 */
  readonly sensitiveValues: BoundedSensitiveValues;
  write(text: string, source: unknown): string;
  flush(source: unknown): string;
  /** まだ確定していない末尾を、マスクして返す。 */
  preview(source: unknown): string;
}

export interface SensitiveTextCommit {
  readonly text: string;
  readonly ranges: readonly SensitiveRange[];
}

function pendingSensitiveValueRanges(text: string): SensitiveRange[] {
  // ストリーム用にキーや区切りの検出規則を複製しない。'@' は、まだ '@' が届いていない URL の認証情報を保留するため。
  return ['', '"', "'", '\\"', '@'].flatMap((quote) =>
    sensitiveTextRanges(text + 'x' + quote, new Set())
      .filter((range) => range.end > text.length)
      .map((range) => ({ start: range.start, end: text.length })));
}

function knownValuePrefixSuffixRanges(text: string, values: ReadonlySet<string>): SensitiveRange[] {
  const ranges: SensitiveRange[] = [];
  for (const value of values) {
    for (let length = Math.min(value.length - 1, text.length); length > 0; length--) {
      if (text.endsWith(value.slice(0, length))) {
        ranges.push({ start: text.length - length, end: text.length });
        break;
      }
    }
  }
  return ranges;
}

/** Complete value-bearing lines and closed PEM blocks become append-only output. */
export class SensitiveTextStreamBuffer {
  readonly sensitiveValues = createBoundedSensitiveValues();
  private pending = '';
  private pemLabel: string | undefined;

  write(text: string, source: unknown, substringValues: readonly string[] = []): SensitiveTextCommit {
    this.sensitiveValues.collect(source);
    this.pending += text;
    let committed = '';
    const ranges: SensitiveRange[] = [];
    const take = (end: number): void => {
      const unit = this.take(end, substringValues);
      for (const range of unit.ranges) ranges.push({ start: committed.length + range.start, end: committed.length + range.end });
      committed += unit.text;
    };
    while (this.pending !== '') {
      if (this.pemLabel !== undefined) {
        const closing = `-----END ${this.pemLabel}-----`;
        const end = this.pending.indexOf(closing);
        if (end < 0) break;
        take(end + closing.length);
        continue;
      }
      let newline = this.pending.indexOf('\n');
      while (newline >= 0 && pendingSensitiveValueRanges(this.pending.slice(0, newline + 1)).length > 0) {
        newline = this.pending.indexOf('\n', newline + 1);
      }
      const line = newline < 0 ? this.pending : this.pending.slice(0, newline + 1);
      const begin = PEM_BEGIN.exec(line);
      if (begin !== null) {
        this.pemLabel = begin[1]!;
        continue;
      }
      if (newline >= 0) { take(newline + 1); continue; }
      // This is a deliberate best-effort boundary, not a continuing credential context.
      if (this.pending.length > MAX_PENDING_SENSITIVE_LINE_LENGTH) take(this.pending.length);
      break;
    }
    return { text: committed, ranges };
  }

  flush(source: unknown, substringValues: readonly string[] = []): SensitiveTextCommit {
    this.sensitiveValues.collect(source);
    return this.take(this.pending.length, substringValues);
  }

  preview(source: unknown): string {
    if (this.pending === '') return '';
    this.sensitiveValues.collect(source);
    if (this.pemLabel !== undefined && this.pending.length > MAX_PENDING_SENSITIVE_LINE_LENGTH) return REDACTED_VALUE;
    const text = this.pending;
    // 左端で切れた秘密値も漏らさないため、保留中の文字列全体をマスクしてから切る。
    // previewだけの発見を、確定済みの候補へ持ち越さない。
    const values = createBoundedSensitiveValues();
    values.collect(this.sensitiveValues);
    const ranges = [
      ...maskingRanges(text, values),
      ...pendingSensitiveValueRanges(text),
      ...knownValuePrefixSuffixRanges(text, values.values),
    ];
    return sliceUtf8(maskSensitiveRanges(text, ranges), 0, SENSITIVE_PREVIEW_BYTES, true).content;
  }

  private take(end: number, substringValues: readonly string[]): SensitiveTextCommit {
    const text = this.pending.slice(0, end);
    this.pending = this.pending.slice(end);
    this.pemLabel = undefined;
    return {
      text,
      ranges: [
        ...maskingRanges(text, this.sensitiveValues),
        ...substringSensitiveRanges(text, substringValues),
        ...knownValuePrefixSuffixRanges(text, this.sensitiveValues.values),
      ],
    };
  }
}

/** Preserve text/thinking ownership without moving text across provider channels. */
export function maskSensitiveTextChunks<T extends { text: string }>(commit: SensitiveTextCommit, chunks: T[]): {
  committed: T[]; pending: T[];
} {
  if (commit.text === '') return { committed: [], pending: chunks };
  const sensitive = new Uint8Array(commit.text.length);
  for (const range of commit.ranges) sensitive.fill(1, range.start, range.end);
  const committed: T[] = [];
  const pending: T[] = [];
  let offset = 0;
  for (const chunk of chunks) {
    const consumed = Math.min(chunk.text.length, Math.max(0, commit.text.length - offset));
    const ranges: SensitiveRange[] = [];
    for (let index = 0; index < consumed;) {
      if (sensitive[offset + index] !== 1) { index++; continue; }
      const start = index++;
      while (index < consumed && sensitive[offset + index] === 1) index++;
      ranges.push({ start, end: index });
    }
    if (consumed > 0) {
      const masked = maskSensitiveRanges(chunk.text.slice(0, consumed), ranges);
      const continues = sensitive[offset] === 1 && offset > 0 && sensitive[offset - 1] === 1;
      committed.push({ ...chunk, text: continues ? masked.slice(REDACTED_VALUE.length) : masked });
    }
    if (consumed < chunk.text.length) pending.push({ ...chunk, text: chunk.text.slice(consumed) });
    offset += chunk.text.length;
  }
  return { committed, pending };
}

export function createSensitiveTextStreamRedactor(): SensitiveTextStreamRedactor {
  const buffer = new SensitiveTextStreamBuffer();
  const mask = (commit: SensitiveTextCommit): string => maskSensitiveRanges(commit.text, commit.ranges);
  return {
    sensitiveValues: buffer.sensitiveValues,
    write: (text, source) => mask(buffer.write(text, source)),
    flush: (source) => mask(buffer.flush(source)),
    preview: (source) => buffer.preview(source),
  };
}
