import { REDACTED_VALUE } from '../utils/sensitive-text.js';
import {
  type BoundedSensitiveValues,
  createBoundedSensitiveValues,
  createSensitiveTextStreamRedactor,
  MAX_INSPECTED_BYTES_PER_SOURCE,
  sanitizeSensitiveTextWithKnownValues,
} from '../utils/sensitiveText.js';
import { stripAnsi } from '../utils/text.js';
import type { ToolActivityResultView } from './presentation.js';
import { classifyToolResult, stableToolResultPrefix, StreamingToolOutput } from './result.js';
import { toolResultSensitiveValues, writeToolResultText } from './sanitize.js';
import type { ToolActivityEntry } from './types.js';

// 改行のない行は、この長さごとに区切って秘密値の収集を確定する。
// 行全体を追記のたびに処理し直すと、改行のない進捗表示などで処理量が出力の長さの二乗で増えるため。
const MAX_OPEN_LINE_LENGTH = 16 * 1024;

/** 出力の先頭の JSON 値が閉じたかを、追記分だけを読んで判定する。 */
class JsonValueEnd {
  closed = false;
  private depth = 0;
  private inString = false;
  private escaped = false;

  /** 追記分を読み、この追記で先頭の値が閉じたら true を返す。 */
  read(text: string): boolean {
    for (const char of text) {
      if (this.inString) {
        if (this.escaped) this.escaped = false;
        else if (char === '\\') this.escaped = true;
        else if (char === '"') this.inString = false;
      } else if (char === '"') {
        this.inString = true;
      } else if (char === '{' || char === '[') {
        this.depth += 1;
      } else if ((char === '}' || char === ']') && --this.depth === 0) {
        this.closed = true;
        return true;
      }
    }
    return false;
  }
}

/**
 * 実行中の entry の表示用の結果。追記分だけを分類・秘密値の収集・マスクにかけ、描画のたびに出力全体を処理し直さない。
 * 完了した entry と同じく、出力から見つかった秘密値は入力ラベルと、それより前に表示した部分のマスクにも使う。
 */
export class RunningToolResult {
  private readonly output = new StreamingToolOutput();
  private readonly redactor = createSensitiveTextStreamRedactor();
  private readonly values = createBoundedSensitiveValues();
  private readonly json = new JsonValueEnd();
  private maskValues = toolResultSensitiveValues(this.values);
  /**
   * 入力ラベルなどのマスクに使う秘密値。改行で終わっていない行の値は、行が終わるまで仮に加える。
   * 行の途中で切れた値を残すと、本来の値の一部だけを秘密値として持ち続けるため、確定した値とは分けて持つ。
   */
  private labelValues = this.values;
  /** 読んだ出力の長さとバイト数。 */
  private readLength = 0;
  private readBytes = 0;
  /** 秘密値を集めた範囲。直前に集めた範囲の先頭から集め直し、名前と値が範囲の境目をはさむ形も拾う。 */
  private collectedStart = 0;
  private collectedEnd = 0;
  private jsonReadLength = 0;
  /** redactor が確定した表示用テキストと、そのうちマスクを確定した部分。 */
  private text = '';
  private maskedLength = 0;
  private maskedText = '';
  private viewText = '';

  read(entry: ToolActivityEntry): void {
    const changed = this.collect(entry);
    const appended = this.output.read(entry.output);
    // 出力から集めた値も redactor に渡し、前の行で見つかった値も伏せる。
    if (appended !== '') this.text += writeToolResultText(this.redactor, appended, this.values);
    this.refresh(changed);
    this.labelValues = this.withOpenLineValues(entry.output.slice(this.collectedEnd));
  }

  view(): ToolActivityResultView {
    return { text: this.viewText, sensitiveValues: this.labelValues };
  }

  private withOpenLineValues(openLine: string): BoundedSensitiveValues {
    if (openLine === '') return this.values;
    const values = createBoundedSensitiveValues();
    values.collect(this.values);
    values.collect(openLine);
    return values;
  }

  /** 追記分から秘密値を集め、集めた値が変わったかを返す。 */
  private collect(entry: ToolActivityEntry): boolean {
    const size = this.values.values.size;
    const exhausted = this.values.exhausted;
    this.values.collect(entry.input);
    const appended = entry.output.slice(this.readLength);
    this.readLength = entry.output.length;
    this.readBytes += Buffer.byteLength(appended);
    // 完了した entry と同じく、出力全体が走査の上限を超えたら fail-closed にする。
    if (this.readBytes > MAX_INSPECTED_BYTES_PER_SOURCE) this.values.exhaust('source_scan');
    const newline = appended.lastIndexOf('\n');
    const end = newline >= 0 ? this.readLength - appended.length + newline + 1
      : this.readLength - this.collectedEnd > MAX_OPEN_LINE_LENGTH ? this.readLength : this.collectedEnd;
    if (end > this.collectedEnd) {
      this.values.collect(entry.output.slice(this.collectedStart, end));
      this.collectedStart = this.collectedEnd;
      this.collectedEnd = end;
    }
    this.collectParsed(entry.output);
    return this.values.values.size !== size || this.values.exhausted !== exhausted;
  }

  /** 構造化データの出力は、先頭の値が閉じた時点で一度だけ parse し、項目名で判る秘密値を集める。 */
  private collectParsed(output: string): void {
    if (this.json.closed) return;
    const stable = stableToolResultPrefix(output.slice(this.jsonReadLength));
    this.jsonReadLength += stable.length;
    if (this.json.read(stripAnsi(stable))) this.values.collect(classifyToolResult(output, false).parsed);
  }

  /**
   * redactor が確定した行を追加分だけマスクする。redactor は改行で終わった行だけを確定するので、追加分は行の途中から始まらない。
   * 集めた秘密値が変わったら、前に表示した行にも新しい値を使うため最初からマスクし直す。
   */
  private refresh(valuesChanged: boolean): void {
    if (valuesChanged) {
      this.maskValues = toolResultSensitiveValues(this.values);
      this.maskedLength = 0;
      this.maskedText = '';
    }
    if (this.maskValues.exhausted) {
      this.viewText = this.text === '' ? '' : REDACTED_VALUE;
      return;
    }
    this.maskedText += this.mask(this.text.slice(this.maskedLength));
    this.maskedLength = this.text.length;
    this.viewText = this.maskedText;
  }

  private mask(text: string): string {
    return text === '' ? text : sanitizeSensitiveTextWithKnownValues(text, this.maskValues);
  }
}
