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
  | { kind: 'unavailable_tool_loop'; tool: string; fingerprint: string; message: string }
  | { kind: 'invalid_argument_loop'; tool: string; fingerprint: string; message: string }
  | { kind: 'edit_conflict_loop'; tool: 'edit'; signature: string; filePath: string; message: string }
  | { kind: 'tool_success_loop'; tool: string; message: string }
  | { kind: 'tool_error_burst'; fingerprint: string; stats: ToolHealthStats; message: string }
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
  /** 同一入力・同一結果の成功ツール呼び出し反復の発火閾値。 */
  successRepeats: number;
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
    successRepeats: resolveEnvInt('TAKT_OPENCODE_TOOL_SUCCESS_REPEATS', 12),
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

function stableSerializeToolInput(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerializeToolInput(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const properties = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableSerializeToolInput(record[key])}`);
    return `{${properties.join(',')}}`;
  }
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'number:NaN';
    if (Object.is(value, -0)) return 'number:-0';
    return `number:${value}`;
  }
  if (typeof value === 'bigint') {
    return `bigint:${value}`;
  }
  return `${typeof value}:${JSON.stringify(value)}`;
}

function computeToolSuccessOutputHash(output: unknown): string {
  return createHash('sha256').update(stableSerializeToolInput(output)).digest('hex');
}

/**
 * 1回の call() 全体を見守る tool ガード。attempt（transient retry / recovery）を
 * またいで1インスタンスを使い回す。attempt 開始時は短期カウンタをリセットし、
 * 成功台帳は実際のセッション ID が変わった場合だけリセットする。絶対台帳は
 * リセットしない。
 */
export class OpenCodeToolGuard {
  // --- 絶対台帳（call 全体。recovery でリセットしない） ---
  private totalErrors = 0;
  private totalSuccesses = 0;
  private maxConsecutiveErrors = 0;
  private maxSameSignatureRepeats = 0;
  private recoveriesUsed = 0;
  private readonly absoluteSignatureCounts = new Map<string, number>();

  // --- セッション固有の短期カウンタ（resetSessionCounters() で毎 attempt リセット） ---
  private consecutiveErrors = 0;
  private toolEventsSinceLastProgress = 0;
  private recentWindow: boolean[] = []; // true = error
  private readonly sessionSignatureCounts = new Map<string, number>();
  private readonly unavailableDetector = new UnavailableToolLoopDetector();
  private readonly invalidArgumentDetector = new InvalidToolArgumentLoopDetector();
  private lastErrorCallId: string | undefined;
  private successfulLedgerSessionId: string | undefined;
  private readonly successfulCallIds = new Set<string>();
  private readonly successfulToolResults = new Map<string, { outputHash: string; repeats: number }>();

  /** テキスト生成の観測。既存挙動の維持: unavailable 検出器の連続性だけを切る。 */
  noteTextActivity(): void {
    this.unavailableDetector.reset();
  }

  /** guard recovery（correction / fresh session）の消費を絶対台帳へ記録する。 */
  noteRecovery(): void {
    this.recoveriesUsed += 1;
  }

  /**
   * 新 attempt 開始時の短期カウンタリセット。絶対台帳（総数・最大値・絶対署名・
   * recovery 数）は引き継ぐ。成功台帳は実際のセッションが変わったときだけ
   * クリアする。
   */
  resetSessionCounters(activeSessionId: string): void {
    this.consecutiveErrors = 0;
    this.toolEventsSinceLastProgress = 0;
    this.recentWindow = [];
    this.sessionSignatureCounts.clear();
    this.unavailableDetector.reset();
    this.invalidArgumentDetector.reset();
    this.lastErrorCallId = undefined;
    if (this.successfulLedgerSessionId !== activeSessionId) {
      this.successfulLedgerSessionId = activeSessionId;
      this.successfulCallIds.clear();
      this.successfulToolResults.clear();
    }
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
  observeSuccess(
    toolCallId: string,
    tool: string,
    input: unknown,
    output: unknown,
  ): ToolGuardFailure | undefined {
    if (this.successfulCallIds.has(toolCallId)) {
      return undefined;
    }
    this.successfulCallIds.add(toolCallId);
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

    const normalizedTool = tool.toLowerCase();
    if (normalizedTool === 'edit' || normalizedTool === 'write' || normalizedTool === 'patch') {
      this.successfulToolResults.clear();
      return undefined;
    }

    const inputSignature = `${normalizedTool}\0${stableSerializeToolInput(input)}`;
    const outputHash = computeToolSuccessOutputHash(output);
    const previous = this.successfulToolResults.get(inputSignature);
    const repeats = previous?.outputHash === outputHash ? previous.repeats + 1 : 1;
    this.successfulToolResults.set(inputSignature, { outputHash, repeats });

    const config = resolveToolGuardConfig();
    if (repeats >= config.successRepeats) {
      return {
        kind: 'tool_success_loop',
        tool: normalizedTool,
        message: `OpenCode successful tool result loop detected: tool "${normalizedTool}" completed with the same input and result ${repeats} times in this session`,
      };
    }
    return undefined;
  }

  /**
   * ツールエラーの観測。発火順は「絶対上限 → 連続性検出 → 進捗感知 burst」。
   * 同一 callId の重複イベントは1回として数える。
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

    if (toolCallId !== this.lastErrorCallId) {
      this.lastErrorCallId = toolCallId;
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

      // 絶対コスト上限（recovery をまたぐ台帳）は recoverable detector より
      // 優先する。同じイベントで両方の閾値に達しても correction/fresh の予算を
      // 消費せず hard stop にする。
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

      if (unavailable !== undefined) {
        return {
          kind: 'unavailable_tool_loop',
          tool: unavailable.tool,
          fingerprint: `unavailable:${unavailable.tool.toLowerCase()}`,
          message: unavailable.message,
        };
      }
      if (invalidArgument !== undefined) {
        return {
          kind: 'invalid_argument_loop',
          tool,
          fingerprint: `invalid:${tool.toLowerCase()}`,
          message: invalidArgument,
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
          fingerprint: 'tool_error_burst',
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
 * - correction: recoverable な tool-loop に対する同一セッション内の是正指示
 * - fresh session: correction 後の再発、または correction 予算超過に対して1回
 *   （tool-loop 種別で合計1回を共有）
 * どちらも使い切った後の再発は本物の失敗（needs_fix / plan への自動迂回は
 * しない — インフラ障害とレビュー判断を混同しない、という codex 裁定）。
 */
export interface ToolGuardRecoveryState {
  /** コール全体で消費した correction 回数（上限は editCorrectionLimit）。 */
  readonly correctionsUsed: number;
  /** correction 済みの detector fingerprint。再発は fresh へ escalate する。 */
  readonly correctedFingerprints: readonly string[];
  /** 次の attempt が correction（同一セッション再開）であることを示す。 */
  readonly pendingCorrection?: {
    readonly sessionId: string;
    readonly fingerprint: string;
    readonly prompt: string;
  };
  readonly freshSessionUsed: boolean;
  /** fresh recovery 発動理由（前置文とログに使う）。 */
  readonly freshReason?: ToolGuardRecoverableKind;
}

export type ToolGuardRecoverableKind = Extract<
  ToolGuardFailure['kind'],
  'unavailable_tool_loop' | 'invalid_argument_loop' | 'edit_conflict_loop' | 'tool_error_burst'
>;

export type ToolGuardRecoverableFailure = Extract<
  ToolGuardFailure,
  { kind: ToolGuardRecoverableKind }
>;

export function createToolGuardRecoveryState(): ToolGuardRecoveryState {
  return { correctionsUsed: 0, correctedFingerprints: [], freshSessionUsed: false };
}

/**
 * この tool-loop 発火に correction を発行してよいか。correction 済み fingerprint の
 * 再発は不可（fresh へ escalate）。新規 fingerprint はコール全体の上限内で可。
 */
export function shouldIssueToolGuardCorrection(
  state: ToolGuardRecoveryState,
  fingerprint: string,
): boolean {
  return !state.correctedFingerprints.includes(fingerprint)
    && state.correctionsUsed < resolveToolGuardConfig().editCorrectionLimit;
}

export function markToolGuardCorrectionPending(
  state: ToolGuardRecoveryState,
  sessionId: string,
  fingerprint: string,
  prompt: string,
): ToolGuardRecoveryState {
  return {
    ...state,
    correctionsUsed: state.correctionsUsed + 1,
    correctedFingerprints: [...state.correctedFingerprints, fingerprint],
    pendingCorrection: { sessionId, fingerprint, prompt },
  };
}

export function clearToolGuardPendingCorrection(state: ToolGuardRecoveryState): ToolGuardRecoveryState {
  const cleared = { ...state };
  delete (cleared as { pendingCorrection?: unknown }).pendingCorrection;
  return cleared;
}

export function markToolGuardFreshSessionUsed(
  state: ToolGuardRecoveryState,
  reason: ToolGuardRecoverableKind,
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

export function buildToolGuardCorrectionPrompt(
  failure: ToolGuardRecoverableFailure,
  serverAvailableTools: readonly string[] | undefined,
): string {
  if (failure.kind === 'edit_conflict_loop') {
    return buildEditConflictCorrectionPrompt(failure.filePath);
  }
  if (failure.kind === 'unavailable_tool_loop') {
    const available = serverAvailableTools === undefined
      ? 'Use only tools currently available in this session.'
      : `Use only these available tools: ${serverAvailableTools.map((tool) => JSON.stringify(tool)).join(', ')}.`;
    return [
      `Your recent attempts repeatedly called unavailable tool ${JSON.stringify(failure.tool)}. Stop calling it.`,
      available,
      'Re-read the current task context and continue using valid tools only. Do not repeat the original prompt.',
    ].join('\n');
  }
  if (failure.kind === 'invalid_argument_loop') {
    return [
      `Your recent calls to ${JSON.stringify(failure.tool)} repeatedly used invalid arguments.`,
      'Stop repeating the same call. Re-read the tool requirements and current file state, then use a complete, correctly typed argument object.',
      'Continue the current task without repeating the original prompt.',
    ].join('\n');
  }
  return [
    'Your recent tool calls are failing repeatedly without progress.',
    'Pause, re-read the current task and relevant workspace state, then make one deliberate valid tool call instead of repeating the failing pattern.',
    'Continue the current task without repeating the original prompt.',
  ].join('\n');
}

/**
 * fresh-session recovery 用の前置文。unavailable-tool recovery と同じ機構・
 * パターン: workspace に途中成果が存在する・上書きするな・対象を再読込せよ。
 */
export function buildToolGuardRetryPrompt(
  prompt: string,
  reason: ToolGuardRecoverableKind,
): string {
  const reasonLine = buildFreshRecoveryReason(reason);
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

function buildFreshRecoveryReason(reason: ToolGuardRecoverableKind): string {
  switch (reason) {
    case 'edit_conflict_loop':
      return 'Your previous session kept failing the same edit because its oldString did not match the file content.';
    case 'unavailable_tool_loop':
      return 'Your previous session repeatedly called an unavailable tool.';
    case 'invalid_argument_loop':
      return 'Your previous session repeatedly called a tool with invalid arguments.';
    case 'tool_error_burst':
      return 'Your previous session degraded into a burst of failing tool calls without making progress.';
  }
}
