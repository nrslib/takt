import { stripAnsi } from '../utils/text.js';
import { REDACTED_VALUE } from '../utils/sensitive-text.js';

const RESULT_FIELDS = ['stdout', 'stderr', 'output', 'content', 'text', 'message', 'result'] as const;
const TEXT_PREFIXES = ['[DEBUG]', '[INFO]', '[WARN]', '[ERROR]', REDACTED_VALUE];
const OMITTED = '[structured output omitted]';

type ToolOutputStart = 'pending' | 'text' | 'structured';

interface ToolResult {
  kind: ToolOutputStart;
  text: string;
  parsed?: unknown;
}

/** ANSI 列を除いた出力の先頭から、テキストか構造化データらしいかを判定する。判定できない短い先頭は pending。 */
function outputStart(normalized: string): ToolOutputStart {
  const leading = normalized.trimStart();
  if (leading === '' || TEXT_PREFIXES.some((prefix) => prefix.startsWith(leading) && prefix !== leading)) return 'pending';
  const structured = leading.startsWith('{') || leading.startsWith('[');
  return TEXT_PREFIXES.some((prefix) => leading.startsWith(prefix)) || !structured ? 'text' : 'structured';
}

// 分割されたANSI列は、次のチャンクで確定するまで文字列処理へ渡さない。
export function stableToolResultPrefix(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const incompleteEscape = /\x1b(?:\[[0-?]*[ -/]*|\][^\x07\x1b]*(?:\x1b)?|)(?![\s\S])/u.exec(raw);
  return incompleteEscape === null ? raw : raw.slice(0, incompleteEscape.index);
}

const JSON_WHITESPACE = ' \t\n\r';
const JSON_LITERALS = ['true', 'false', 'null'] as const;
const JSON_NUMBER_CHAR = /[0-9eE+\-.]/u;

/** 文字列リテラルの直後の位置を返す。閉じていなければ -1。 */
function skipJsonString(text: string, start: number): number {
  for (let index = start + 1; index < text.length; index++) {
    if (text[index] === '\\') index++;
    else if (text[index] === '"') return index + 1;
  }
  return -1;
}

/** 先頭から JSON として矛盾なく読め、値の途中で終わっているか。`[1/3] Building` のように括弧で始まるだけのテキストは false。 */
function isTruncatedJson(text: string): boolean {
  const containers: string[] = [];
  let expected: 'value' | 'firstValue' | 'key' | 'firstKey' | 'colon' | 'next' = 'value';
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (JSON_WHITESPACE.includes(char)) {
      index++;
      continue;
    }
    const closing = containers.at(-1) === '{' ? '}' : ']';
    const atKey: boolean = expected === 'key' || expected === 'firstKey';
    if (expected === 'colon') {
      if (char !== ':') return false;
      expected = 'value';
      index++;
    } else if (expected === 'next') {
      if (containers.length === 0) return false;
      if (char === ',') expected = containers.at(-1) === '{' ? 'key' : 'value';
      else if (char === closing) containers.pop();
      else return false;
      index++;
    } else if ((expected === 'firstKey' || expected === 'firstValue') && char === closing) {
      containers.pop();
      expected = 'next';
      index++;
    } else if (char === '"') {
      index = skipJsonString(text, index);
      if (index < 0) return true;
      expected = atKey ? 'colon' : 'next';
    } else if (atKey) {
      return false;
    } else if (char === '{' || char === '[') {
      containers.push(char);
      expected = char === '{' ? 'firstKey' : 'firstValue';
      index++;
    } else if (char === '-' || (char >= '0' && char <= '9')) {
      while (index < text.length && JSON_NUMBER_CHAR.test(text[index]!)) index++;
      expected = 'next';
    } else {
      const rest = text.slice(index, index + 5);
      const literal = JSON_LITERALS.find((value) => rest.startsWith(value) || value.startsWith(rest));
      if (literal === undefined) return false;
      if (!rest.startsWith(literal)) return true;
      index += literal.length;
      expected = 'next';
    }
  }
  return true;
}

/**
 * JSON として読めない出力は、完了後はテキストとして表示する。ただし途中で切れた JSON は、項目名で秘密値を判別できないので表示しない。
 * 実行中は未完成の JSON と区別できず、後続の項目で秘密値と判る値を先に見せうるため、完了まで保留する。
 */
export function classifyToolResult(raw: string, finished: boolean): ToolResult {
  const stable = stableToolResultPrefix(raw);
  const normalized = stripAnsi(stable);
  const start = outputStart(normalized);
  if (start === 'pending') return { kind: 'pending', text: raw.trim() === '' ? '' : OMITTED };
  if (start === 'text') return { kind: 'text', text: stable };
  let parsed: unknown;
  try {
    parsed = JSON.parse(normalized) as unknown;
  } catch {
    if (!finished) return { kind: 'pending', text: OMITTED };
    return isTruncatedJson(normalized.trimStart()) ? { kind: 'structured', text: OMITTED } : { kind: 'text', text: stable };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind: 'structured', text: OMITTED, parsed };
  }
  const record = parsed as Record<string, unknown>;
  const fields = RESULT_FIELDS.flatMap((key): string[] => {
    if (!Object.hasOwn(record, key)) return [];
    const value = record[key];
    if (typeof value === 'string') return [value];
    if (key !== 'content' || !Array.isArray(value)) return [];
    return value.flatMap((block: unknown) => {
      if (block === null || typeof block !== 'object') return [];
      const item = block as Record<string, unknown>;
      return item.type === 'text' && typeof item.text === 'string' ? [item.text] : [];
    });
  });
  return { kind: 'structured', text: fields.length > 0 ? fields.join('\n') : OMITTED, parsed };
}

/**
 * 実行中に伸びていく出力を、追記分ごとに読む。先頭でテキストと判定したら判定を覚え、以後は追記分だけを返す。
 * 構造化データらしい出力は完了時の結果で表示するので、実行中は parse せず何も返さない。
 */
export class StreamingToolOutput {
  private start: ToolOutputStart = 'pending';
  /** テキストとして読み終えた出力の長さ。分割された ANSI 列は、次のチャンクで確定するまで読まない。 */
  private consumed = 0;

  read(output: string): string {
    if (this.start === 'pending') this.start = outputStart(stripAnsi(stableToolResultPrefix(output)));
    if (this.start !== 'text') return '';
    const appended = stableToolResultPrefix(output.slice(this.consumed));
    this.consumed += appended.length;
    return appended;
  }

  /** 全体を判定してテキストとなった出力（classifyToolResult の text）のうち、まだ読んでいない残りを返す。 */
  readRest(text: string): string {
    const rest = text.slice(this.consumed);
    this.consumed = text.length;
    return rest;
  }
}
