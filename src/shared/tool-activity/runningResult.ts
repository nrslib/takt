import { createSensitiveTextStreamRedactor } from '../utils/sensitiveText.js';
import type { ToolActivityResultView } from './presentation.js';
import { classifyToolResult } from './result.js';
import { normalizeToolResultText, toolResultSensitiveValues } from './sanitize.js';
import type { ToolActivityEntry } from './types.js';

/** 通常TUIの生出力だけに使う。daemonでマスク済みの出力には適用しない。 */
export class RunningToolResult {
  private readonly redactor = createSensitiveTextStreamRedactor();
  private consumed = 0;
  private text = '';

  read(entry: ToolActivityEntry): void {
    const source = toolResultSensitiveValues(entry.input);
    this.redactor.sensitiveValues.collect(source);
    const result = classifyToolResult(entry.output);
    // JSONの項目名から後で判る秘密値を、完了前に公開しない（mainと同じ）。
    if (result.kind !== 'text') return;
    const normalized = normalizeToolResultText(result.text);
    this.text += this.redactor.write(normalized.slice(this.consumed), source);
    this.consumed = normalized.length;
  }

  /** 確定していない末尾は、マスクした仮の表示として足すだけで、確定させない。 */
  preview(entry: ToolActivityEntry): ToolActivityResultView {
    return { text: this.text + this.redactor.preview(toolResultSensitiveValues(entry.input)), sensitiveValues: this.redactor.sensitiveValues };
  }
}
