const UNAVAILABLE_TOOL_ERROR_PATTERNS = [
  'unavailable tool',
  'invalid tool',
];

const REPEATED_UNAVAILABLE_TOOL_THRESHOLD = 2;

function isUnavailableToolErrorMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return UNAVAILABLE_TOOL_ERROR_PATTERNS.some((pattern) => lower.includes(pattern));
}

/**
 * UnavailableToolLoopDetector の発火結果。
 *
 * エラー文字列だけを返すと、受け側（client.ts の recovery 判定）が
 * 「どのツールで発火したか」を文字列の再パースで推測する羽目になる。
 * ツール名を型で運び、recovery の対象判定（StructuredOutput か一般ツールか）を
 * 正規表現なしで行えるようにする。
 */
export interface UnavailableToolLoopDetection {
  readonly tool: string;
  readonly message: string;
}

export class UnavailableToolLoopDetector {
  private consecutiveUnavailableToolErrors = 0;
  private lastUnavailableToolCallId: string | undefined;

  observe(toolCallId: string, tool: string, message: string): UnavailableToolLoopDetection | undefined {
    if (!isUnavailableToolErrorMessage(message)) {
      this.reset();
      return undefined;
    }

    if (toolCallId === this.lastUnavailableToolCallId) {
      return undefined;
    }

    this.lastUnavailableToolCallId = toolCallId;
    this.consecutiveUnavailableToolErrors += 1;

    if (this.consecutiveUnavailableToolErrors < REPEATED_UNAVAILABLE_TOOL_THRESHOLD) {
      return undefined;
    }

    return {
      tool,
      message: `OpenCode unavailable tool loop detected for tool "${tool}": ${message}`,
    };
  }

  reset(): void {
    this.consecutiveUnavailableToolErrors = 0;
    this.lastUnavailableToolCallId = undefined;
  }
}

const INVALID_ARGUMENT_ERROR_PATTERNS = [
  'invalid arguments',
  'schemaerror',
  // OpenCode は必須引数の欠落をスキーマ検証の手前で弾き、SchemaError ではなく
  // この文言で返す（実測: qwen が read を filePath 無しで 219 回連続で呼んだ）。
  'is missing or invalid',
];

// 引数エラーは正常な試行錯誤でも起きるため、unavailable より閾値を緩くする。
const REPEATED_INVALID_ARGUMENT_THRESHOLD = 4;

function isInvalidArgumentErrorMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return INVALID_ARGUMENT_ERROR_PATTERNS.some((pattern) => lower.includes(pattern));
}

/**
 * 実在するツールを壊れた引数で呼び続けるループの検出器。
 * UnavailableToolLoopDetector の兄弟: あちらは「存在しないツール」、
 * こちらは「同一ツールへの引数バリデーションエラーの連発」を打ち切る。
 * 実測では弱いモデルがこの状態で10分以上もがき続けた。
 */
export class InvalidToolArgumentLoopDetector {
  private consecutiveInvalidArgumentErrors = 0;
  private lastToolName: string | undefined;
  private lastCallId: string | undefined;

  observe(toolCallId: string, tool: string, message: string): string | undefined {
    if (!isInvalidArgumentErrorMessage(message)) {
      this.reset();
      return undefined;
    }

    if (toolCallId === this.lastCallId) {
      return undefined;
    }
    this.lastCallId = toolCallId;

    if (tool !== this.lastToolName) {
      this.lastToolName = tool;
      this.consecutiveInvalidArgumentErrors = 1;
      return undefined;
    }

    this.consecutiveInvalidArgumentErrors += 1;
    if (this.consecutiveInvalidArgumentErrors < REPEATED_INVALID_ARGUMENT_THRESHOLD) {
      return undefined;
    }

    return `OpenCode invalid tool argument loop detected for tool "${tool}": ${message}`;
  }

  reset(): void {
    this.consecutiveInvalidArgumentErrors = 0;
    this.lastToolName = undefined;
    this.lastCallId = undefined;
  }
}

// 旧 ToolErrorBudgetDetector（1コール内エラー総数の単純累積、既定25）は
// tool-guard.ts の進捗感知型 burst 検出 + 絶対コスト上限に置き換えられた
// （v3-r4 実測: 成功を挟む生産的走行を空転と誤分類して run を殺していた）。
