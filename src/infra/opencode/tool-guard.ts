/**
 * OpenCode の tool ガード（v3-r4 実測 + codex 設計裁定）。
 *
 * 旧 ToolErrorBudgetDetector（1コール内エラー総数の単純累積、既定25）は、
 * 成功ツールコールを考慮しないため「弱いモデルが生産的に働きながら払う
 * edit 税」（v3-r4 実測: 14分半に散発25エラー・間に成功多数）を、導入動機の
 * 「プロバイダ劣化の559ループ・26分空転」と同一視して run を殺していた。
 *
 * 本モジュールは3分離で置き換える:
 * 1. 型付き検出結果（ToolGuardFailure union）— engine 側で文字列を再解析しない
 * 2. 進捗感知型の退行検出（tool_error_burst）— 直近N件のエラー率・成功なし
 *    連続数・同一署名反復で判定。弱い進捗（read/glob/grep 成功）は短期密度を
 *    緩和し、強い進捗（write/edit/bash 成功）は短期カウンタをリセットする
 * 3. 絶対コスト上限（absolute_cost_limit）— fresh-session recovery をまたいで
 *    引き継ぐ台帳。recovery でリセットされない
 *
 * edit の幻覚 oldString 反復（v3-r4 で 19/25）には専用の edit_conflict_loop を
 * 設け、同一セッション内 correction → fresh session recovery の bounded な
 * 救済に接続する（client.ts）。空白正規化プラグイン案は codex 評価と実測により
 * 不採用が確定済み — 実装しない。
 */

import { createHash } from 'node:crypto';
import {
  InvalidToolArgumentLoopDetector,
  UnavailableToolLoopDetector,
} from './unavailable-tool-loop.js';

/** 観測メトリクス（閾値校正の材料。debug ログと AgentResponse に構造化して残す）。 */
export interface ToolHealthStats {
  /** call 全体（recovery をまたぐ）のツールエラー総数。 */
  totalErrors: number;
  /** call 全体のツール成功総数。 */
  totalSuccesses: number;
  /** call 全体で観測した最大の「成功なし連続エラー」数。 */
  maxConsecutiveErrors: number;
  /** 直近ウィンドウ（短期）のエラー率 0..1。 */
  recentErrorRate: number;
  /** 直近ウィンドウに入っているツール終了イベント数。 */
  recentWindowSize: number;
  /** call 全体で観測した同一エラー署名の最大反復数。 */
  maxSameSignatureRepeats: number;
  /** 最後の進捗（ツール成功）からのツール終了イベント数。 */
  toolEventsSinceLastProgress: number;
  /** call 全体で消費した guard recovery（correction / fresh session）数。 */
  recoveriesUsed: number;
}

export type ToolGuardFailure =
  | { kind: 'unavailable_tool_loop'; tool: string; message: string }
  | { kind: 'invalid_argument_loop'; tool: string; message: string }
  | { kind: 'edit_conflict_loop'; tool: 'edit'; signature: string; filePath: string; message: string }
  | { kind: 'tool_error_burst'; stats: ToolHealthStats; message: string }
  | { kind: 'absolute_cost_limit'; stats: ToolHealthStats; message: string };

/** 呼び出し時に評価する（テスト・実験で env から上書きできるようにする）。 */
function resolveEnvInt(name: string, fallback: number): number {
  const fromEnv = Number(process.env[name]);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? Math.floor(fromEnv) : fallback;
}

export interface ToolGuardConfig {
  /** 絶対上限: call 全体のツールエラー総数（旧予算25より高い既定。recovery でリセットしない）。 */
  absoluteErrorBudget: number;
  /** 絶対上限: 同一署名の call 全体での最大反復。 */
  absoluteSignatureRepeats: number;
  /** burst: 短期ウィンドウの長さ（直近N件のツール終了イベント）。 */
  recentWindow: number;
  /** burst: ウィンドウが満杯のとき発火するエラー率（パーセント）。 */
  recentWindowErrorRatePercent: number;
  /** burst: 成功なし連続エラー数の発火閾値（559スピン型は累積25を待たず検出）。 */
  consecutiveErrors: number;
  /** burst: 非 edit ツールの同一署名短期反復の発火閾値。 */
  sameSignatureRepeats: number;
  /** edit_conflict_loop: 同一署名（filePath + oldString）の失敗反復の発火閾値。 */
  editConflictRepeats: number;
  /** edit_conflict_loop への同一セッション内 correction のコール全体での上限。 */
  editCorrectionLimit: number;
}

export function resolveToolGuardConfig(): ToolGuardConfig {
  return {
    // 既定は現行の保護水準を下回らない保守側:
    // - 純粋な劣化スピン（成功ゼロ）は consecutive=10 で旧25発火より速く止まる
    // - 成功を挟む生産的走行は絶対上限（60）まで burst にならない
    absoluteErrorBudget: resolveEnvInt('TAKT_OPENCODE_TOOL_ERROR_BUDGET', 60),
    absoluteSignatureRepeats: resolveEnvInt('TAKT_OPENCODE_TOOL_SIGNATURE_ABSOLUTE', 12),
    recentWindow: resolveEnvInt('TAKT_OPENCODE_TOOL_ERROR_WINDOW', 20),
    recentWindowErrorRatePercent: resolveEnvInt('TAKT_OPENCODE_TOOL_ERROR_WINDOW_RATE', 90),
    consecutiveErrors: resolveEnvInt('TAKT_OPENCODE_TOOL_ERROR_CONSECUTIVE', 10),
    sameSignatureRepeats: resolveEnvInt('TAKT_OPENCODE_TOOL_SIGNATURE_REPEATS', 8),
    editConflictRepeats: resolveEnvInt('TAKT_OPENCODE_EDIT_CONFLICT_REPEATS', 3),
    // correction 中に別署名の conflict が新たに起きた場合、その署名は自身の
    // correction 段階から始める（codex 裁定）。ただし無限 correction にしない
    // ため、コール全体の回数上限で縛る。
    editCorrectionLimit: resolveEnvInt('TAKT_OPENCODE_EDIT_CORRECTION_LIMIT', 2),
  };
}

/**
 * 強い進捗: 成果物へ向かう副作用のあるツールの成功。短期カウンタをリセットする。
 * 弱い進捗: 読み取り系の成功。短期密度を緩和するが、同一署名カウンタと
 * 絶対上限はリセットしない（読むだけで前へ進んだ保証はない）。
 */
const STRONG_PROGRESS_TOOLS = new Set(['edit', 'write', 'patch', 'bash']);

/** edit の署名 = filePath + oldString のハッシュ。本文はログ・エラーに残さない。 */
export function computeEditConflictSignature(filePath: string, oldString: string): string {
  return createHash('sha256').update(`${filePath}\0${oldString}`).digest('hex');
}

/**
 * 非 edit の同一エラー署名。ツール名 + エラー文の等価クラス（数値を正規化し
 * 有界に切り詰める）。エラー本文そのものは署名にだけ使い、露出はハッシュ。
 */
function computeGenericErrorSignature(tool: string, message: string): string {
  const errorClass = message.toLowerCase().replace(/\d+/g, '#').slice(0, 160);
  return createHash('sha256').update(`${tool}\0${errorClass}`).digest('hex');
}

function extractEditConflictInput(input: unknown): { filePath: string; oldString: string } | undefined {
  if (typeof input !== 'object' || input === null) {
    return undefined;
  }
  const record = input as Record<string, unknown>;
  const filePath = record.filePath;
  const oldString = record.oldString;
  if (typeof filePath !== 'string' || typeof oldString !== 'string' || filePath.length === 0) {
    return undefined;
  }
  return { filePath, oldString };
}

/**
 * 1回の call() 全体を見守る tool ガード。attempt（transient retry / recovery）を
 * またいで1インスタンスを使い回し、attempt 開始時に resetSessionCounters() で
 * セッション固有の短期カウンタだけをリセットする。絶対台帳はリセットしない。
 */
export class OpenCodeToolGuard {
  // --- 絶対台帳（call 全体。recovery でリセットしない） ---
  private totalErrors = 0;
  private totalSuccesses = 0;
  private maxConsecutiveErrors = 0;
  private maxSameSignatureRepeats = 0;
  private recoveriesUsed = 0;
  private readonly absoluteSignatureCounts = new Map<string, number>();

  // --- セッション固有の短期カウンタ（resetSessionCounters() でリセット） ---
  private consecutiveErrors = 0;
  private toolEventsSinceLastProgress = 0;
  private recentWindow: boolean[] = []; // true = error
  private readonly sessionSignatureCounts = new Map<string, number>();
  private readonly unavailableDetector = new UnavailableToolLoopDetector();
  private readonly invalidArgumentDetector = new InvalidToolArgumentLoopDetector();
  private lastCallId: string | undefined;

  /** テキスト生成の観測。既存挙動の維持: unavailable 検出器の連続性だけを切る。 */
  noteTextActivity(): void {
    this.unavailableDetector.reset();
  }

  /** guard recovery（correction / fresh session）の消費を絶対台帳へ記録する。 */
  noteRecovery(): void {
    this.recoveriesUsed += 1;
  }

  /**
   * fresh-session recovery / 新 attempt 開始時のリセット。セッション固有の
   * 短期カウンタのみ。絶対台帳（総数・最大値・絶対署名・recovery 数）は
   * 引き継ぐ（codex 裁定: 絶対台帳を recovery でリセットしない）。
   */
  resetSessionCounters(): void {
    this.consecutiveErrors = 0;
    this.toolEventsSinceLastProgress = 0;
    this.recentWindow = [];
    this.sessionSignatureCounts.clear();
    this.unavailableDetector.reset();
    this.invalidArgumentDetector.reset();
    this.lastCallId = undefined;
  }

  stats(): ToolHealthStats {
    const windowErrors = this.recentWindow.filter(Boolean).length;
    return {
      totalErrors: this.totalErrors,
      totalSuccesses: this.totalSuccesses,
      maxConsecutiveErrors: this.maxConsecutiveErrors,
      recentErrorRate: this.recentWindow.length === 0 ? 0 : windowErrors / this.recentWindow.length,
      recentWindowSize: this.recentWindow.length,
      maxSameSignatureRepeats: this.maxSameSignatureRepeats,
      toolEventsSinceLastProgress: this.toolEventsSinceLastProgress,
      recoveriesUsed: this.recoveriesUsed,
    };
  }

  /** ツール成功の観測。進捗は2段階（強: リセット / 弱: 緩和）。 */
  observeSuccess(toolCallId: string, tool: string): void {
    if (toolCallId === this.lastCallId) {
      return;
    }
    this.lastCallId = toolCallId;
    this.totalSuccesses += 1;
    this.toolEventsSinceLastProgress = 0;
    this.unavailableDetector.reset();
    this.invalidArgumentDetector.reset();
    if (STRONG_PROGRESS_TOOLS.has(tool.toLowerCase())) {
      // 強い進捗: 短期カウンタをリセット（同一署名の短期反復も含む）。
      // 直近ウィンドウも消去する — 率計算が強い進捗を跨ぐと、
      // 「9エラー → bash成功 → 9エラー → bash成功 → 1エラー」のような
      // 健全な試行錯誤（前進しながらの edit 税）がエラー率90%を満たして
      // 誤 burst になる（codex 再現ケース）。
      this.consecutiveErrors = 0;
      this.sessionSignatureCounts.clear();
      this.recentWindow = [];
    } else {
      // 弱い進捗: 短期密度を緩和する（成功をウィンドウへ積み、連続カウンタを
      // 半減）。絶対上限も同一署名反復もリセットしない。
      this.pushWindow(false);
      this.consecutiveErrors = Math.floor(this.consecutiveErrors / 2);
    }
  }

  /**
   * ツールエラーの観測。発火順は「連続性検出（従来ロジック不変）→ 絶対上限 →
   * 進捗感知 burst」。同一 callId の重複イベントは1回として数える。
   */
  observeError(
    toolCallId: string,
    tool: string,
    message: string,
    input?: unknown,
  ): ToolGuardFailure | undefined {
    const config = resolveToolGuardConfig();

    // 連続性ベースの既存検出器には必ず観測させる（callId 重複は各検出器が
    // 自前で除外する。従来の観測順・ロジックを変えない）。
    const unavailable = this.unavailableDetector.observe(toolCallId, tool, message);
    const invalidArgument = this.invalidArgumentDetector.observe(toolCallId, tool, message);

    if (toolCallId !== this.lastCallId) {
      this.lastCallId = toolCallId;
      this.totalErrors += 1;
      this.consecutiveErrors += 1;
      this.maxConsecutiveErrors = Math.max(this.maxConsecutiveErrors, this.consecutiveErrors);
      this.toolEventsSinceLastProgress += 1;
      this.pushWindow(true);

      const editInput = tool === 'edit' ? extractEditConflictInput(input) : undefined;
      const signature = editInput !== undefined
        ? computeEditConflictSignature(editInput.filePath, editInput.oldString)
        : computeGenericErrorSignature(tool, message);
      const sessionCount = (this.sessionSignatureCounts.get(signature) ?? 0) + 1;
      this.sessionSignatureCounts.set(signature, sessionCount);
      const absoluteCount = (this.absoluteSignatureCounts.get(signature) ?? 0) + 1;
      this.absoluteSignatureCounts.set(signature, absoluteCount);
      this.maxSameSignatureRepeats = Math.max(this.maxSameSignatureRepeats, absoluteCount);

      if (unavailable !== undefined) {
        return { kind: 'unavailable_tool_loop', tool: unavailable.tool, message: unavailable.message };
      }
      if (invalidArgument !== undefined) {
        return { kind: 'invalid_argument_loop', tool, message: invalidArgument };
      }

      // 絶対コスト上限（recovery をまたぐ台帳）。edit_conflict より先に判定する:
      // recovery を消費し切った後の同一署名再発は「もう一度 correction を試みる
      // べき事象」ではなく hard stop（即失敗）。
      if (this.totalErrors >= config.absoluteErrorBudget) {
        const stats = this.stats();
        return {
          kind: 'absolute_cost_limit',
          stats,
          message: `OpenCode absolute tool error budget exceeded (${this.totalErrors} tool errors across the whole call incl. recoveries; last tool "${tool}"): ${message}`,
        };
      }
      if (absoluteCount >= config.absoluteSignatureRepeats) {
        const stats = this.stats();
        return {
          kind: 'absolute_cost_limit',
          stats,
          message: `OpenCode absolute same-signature limit exceeded (signature ${signature.slice(0, 12)} repeated ${absoluteCount} times across the whole call incl. recoveries; last tool "${tool}")`,
        };
      }

      // edit_conflict_loop: 同一 filePath + oldString の失敗反復（v3-r4: 19/25 が
      // 幻覚 oldString）。署名はハッシュのみ露出（本文をログ・エラーに残さない）。
      if (editInput !== undefined && sessionCount >= config.editConflictRepeats) {
        return {
          kind: 'edit_conflict_loop',
          tool: 'edit',
          signature,
          filePath: editInput.filePath,
          message: `OpenCode edit conflict loop detected: the same edit (signature ${signature.slice(0, 12)}, file "${editInput.filePath}") failed ${sessionCount} times with an oldString that does not match the file content`,
        };
      }

      // 進捗感知型の退行検出（tool_error_burst）。
      const windowErrors = this.recentWindow.filter(Boolean).length;
      const windowFull = this.recentWindow.length >= config.recentWindow;
      const windowRateExceeded = windowFull
        && windowErrors * 100 >= config.recentWindowErrorRatePercent * this.recentWindow.length;
      const sameSignatureBurst = editInput === undefined && sessionCount >= config.sameSignatureRepeats;
      if (this.consecutiveErrors >= config.consecutiveErrors || windowRateExceeded || sameSignatureBurst) {
        const stats = this.stats();
        return {
          kind: 'tool_error_burst',
          stats,
          message: `OpenCode tool error burst detected (${this.consecutiveErrors} consecutive errors without progress, recent error rate ${(stats.recentErrorRate * 100).toFixed(0)}% over ${stats.recentWindowSize} events; last tool "${tool}"): ${message}`,
        };
      }
    }
    return undefined;
  }

  private pushWindow(isError: boolean): void {
    const config = resolveToolGuardConfig();
    this.recentWindow.push(isError);
    while (this.recentWindow.length > config.recentWindow) {
      this.recentWindow.shift();
    }
  }
}

// ---------------------------------------------------------------------------
// recovery（client.ts の attempt ループが使う bounded な救済状態と前置文）
// ---------------------------------------------------------------------------

/**
 * call() 1回分の tool-guard recovery 状態。
 * - correction: edit_conflict_loop に対する同一セッション内の指示1回
 * - fresh session: correction 後の再発、または tool_error_burst に対して1回
 *   （edit_conflict / burst で合計1回を共有）
 * どちらも使い切った後の再発は本物の失敗（needs_fix / plan への自動迂回は
 * しない — インフラ障害とレビュー判断を混同しない、という codex 裁定）。
 */
export interface ToolGuardRecoveryState {
  /** コール全体で消費した correction 回数（上限は editCorrectionLimit）。 */
  readonly correctionsUsed: number;
  /**
   * correction 済みの署名。edit_conflict の再発火時にこのリストと照合し、
   * 「correction 済み署名の再発 = correction 失敗 → fresh へ escalate」と
   * 「別署名の新規 conflict = 自身の correction 段階から開始」を区別する
   * （codex 指摘: 無検証だと別署名の新規 conflict が共有 fresh recovery を
   * 誤って消費する）。
   */
  readonly correctedSignatures: readonly string[];
  /** 次の attempt が correction（同一セッション再開）であることを示す。 */
  readonly pendingCorrection?: {
    readonly sessionId: string;
    readonly filePath: string;
    readonly signature: string;
  };
  readonly freshSessionUsed: boolean;
  /** fresh recovery 発動理由（前置文とログに使う）。 */
  readonly freshReason?: 'edit_conflict_loop' | 'tool_error_burst';
}

export function createToolGuardRecoveryState(): ToolGuardRecoveryState {
  return { correctionsUsed: 0, correctedSignatures: [], freshSessionUsed: false };
}

/**
 * この edit_conflict 発火に correction を発行してよいか。correction 済み署名の
 * 再発は不可（fresh へ escalate）。新規署名はコール全体の correction 上限内で可。
 */
export function shouldIssueEditConflictCorrection(
  state: ToolGuardRecoveryState,
  signature: string,
): boolean {
  return !state.correctedSignatures.includes(signature)
    && state.correctionsUsed < resolveToolGuardConfig().editCorrectionLimit;
}

export function markToolGuardCorrectionPending(
  state: ToolGuardRecoveryState,
  sessionId: string,
  filePath: string,
  signature: string,
): ToolGuardRecoveryState {
  return {
    ...state,
    correctionsUsed: state.correctionsUsed + 1,
    correctedSignatures: [...state.correctedSignatures, signature],
    pendingCorrection: { sessionId, filePath, signature },
  };
}

export function clearToolGuardPendingCorrection(state: ToolGuardRecoveryState): ToolGuardRecoveryState {
  const cleared = { ...state };
  delete (cleared as { pendingCorrection?: unknown }).pendingCorrection;
  return cleared;
}

export function markToolGuardFreshSessionUsed(
  state: ToolGuardRecoveryState,
  reason: 'edit_conflict_loop' | 'tool_error_burst',
): ToolGuardRecoveryState {
  return { ...clearToolGuardPendingCorrection(state), freshSessionUsed: true, freshReason: reason };
}

/**
 * edit_conflict_loop への同一セッション内 correction 指示。oldString 本文は
 * 含めない（署名ハッシュと filePath だけで特定できる）。
 */
export function buildEditConflictCorrectionPrompt(filePath: string): string {
  return [
    `Your recent edit attempts on ${JSON.stringify(filePath)} keep failing because the oldString you provide does not exist in the file's current content.`,
    'Stop repeating the same oldString. Do the following instead:',
    `1. Re-read ${JSON.stringify(filePath)} to see its CURRENT content.`,
    '2. Base your next edit on what the file actually contains, narrowing oldString to a smaller, exactly-matching span.',
    '3. If a matching span still cannot be constructed, rewrite the affected region with the write tool after confirming the current content.',
    'Then continue the task you were working on.',
  ].join('\n');
}

/**
 * fresh-session recovery 用の前置文。unavailable-tool recovery と同じ機構・
 * パターン: workspace に途中成果が存在する・上書きするな・対象を再読込せよ。
 */
export function buildToolGuardRetryPrompt(
  prompt: string,
  reason: 'edit_conflict_loop' | 'tool_error_burst',
): string {
  const reasonLine = reason === 'edit_conflict_loop'
    ? 'Your previous session kept failing the same edit because its oldString did not match the file content.'
    : 'Your previous session degraded into a burst of failing tool calls without making progress.';
  return [
    'A previous session already worked on this task in the same workspace.',
    reasonLine,
    'IMPORTANT: the workspace already contains partially completed work from that session. Do NOT overwrite or discard it.',
    'Re-read any file you intend to modify FIRST, and base every edit on the file\'s current content (never on remembered content).',
    'If an edit\'s oldString does not match, re-read the file and narrow the span instead of retrying the same string.',
    '',
    prompt,
  ].join('\n');
}
