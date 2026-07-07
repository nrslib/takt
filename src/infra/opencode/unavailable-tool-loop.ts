const UNAVAILABLE_TOOL_ERROR_PATTERNS = [
  'unavailable tool',
  'invalid tool',
];

const REPEATED_UNAVAILABLE_TOOL_THRESHOLD = 2;

function isUnavailableToolErrorMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return UNAVAILABLE_TOOL_ERROR_PATTERNS.some((pattern) => lower.includes(pattern));
}

export class UnavailableToolLoopDetector {
  private consecutiveUnavailableToolErrors = 0;
  private lastUnavailableToolCallId: string | undefined;

  observe(toolCallId: string, tool: string, message: string): string | undefined {
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

    return `OpenCode unavailable tool loop detected for tool "${tool}": ${message}`;
  }

  reset(): void {
    this.consecutiveUnavailableToolErrors = 0;
    this.lastUnavailableToolCallId = undefined;
  }
}

const INVALID_ARGUMENT_ERROR_PATTERNS = [
  'invalid arguments',
  'schemaerror',
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

/** 呼び出し時に評価する（テストで env から上書きできるようにする） */
function resolveToolErrorBudget(): number {
  const fromEnv = Number(process.env.TAKT_OPENCODE_TOOL_ERROR_BUDGET);
  return fromEnv > 0 ? fromEnv : 25;
}

/**
 * 1回の呼び出し内のツールエラー総量の予算。
 * 連続性ベースの検出器（unavailable / invalid-argument）はツール名を変えながら
 * 壊れた呼び出しを繰り返す劣化ループを検出できない（切り替えでリセットされる）。
 * 実測: 夜間のプロバイダ劣化で、1ステップが559ループ・26分の空転を続けた。
 * 正常な試行錯誤がこの予算に届くことはない（実測の健全走行は1桁）。
 */
export class ToolErrorBudgetDetector {
  private totalToolErrors = 0;
  private lastCallId: string | undefined;

  observe(toolCallId: string, tool: string, message: string): string | undefined {
    if (toolCallId === this.lastCallId) {
      return undefined;
    }
    this.lastCallId = toolCallId;
    this.totalToolErrors += 1;

    const budget = resolveToolErrorBudget();
    if (this.totalToolErrors < budget) {
      return undefined;
    }
    return `OpenCode tool error budget exceeded (${this.totalToolErrors} tool errors in one call; last tool "${tool}"): ${message}`;
  }
}
