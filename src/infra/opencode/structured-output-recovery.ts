/**
 * OpenCode の構造化出力（native StructuredOutput ツール）が失敗したときの
 * リカバリ方針を、純粋関数として表現するモジュール。
 *
 * 背景（実測）: セッションキーが persona 既定のため複数ステップが同一
 * セッションを共有し、native StructuredOutput ツールの成功履歴を持つセッションで
 * 別ステップ（schema を要求しない plain な呼び出し）が実行されると、モデルが
 * 記憶にある StructuredOutput を呼び続けて UnavailableToolLoopDetector（閾値2）
 * に引っかかり、ステップごと失敗していた。加えて、native format 自体が
 * 失敗した場合の既存の劣化パスも「同じセッションのまま format を外すだけ」で、
 * 汚染されたセッションを引きずっていた。
 *
 * ここでは条件分岐を client.ts に直書きせず、attempt ごとの方針決定を
 * 状態遷移として切り出す。client.ts はこのモジュールが返す boolean/plan に
 * 従うだけにする。
 */

import type { Language } from '../../core/models/types.js';
import { buildStructuredJsonSchemaInstruction } from '../../shared/prompts/index.js';
import { PROVIDER_NATIVE_STRUCTURED_OUTPUT_TOOL_NAME } from '../../shared/types/provider.js';

/** OpenCode のネイティブ構造化出力ツールの名前。stale recovery の対象判定に使う。 */
export const STRUCTURED_OUTPUT_TOOL_NAME = PROVIDER_NATIVE_STRUCTURED_OUTPUT_TOOL_NAME;

export type OpenCodeStructuredOutputSessionMode = 'resume' | 'fresh';
export type OpenCodeStructuredOutputMode = 'native' | 'formatless' | 'plain';

export interface OpenCodeStructuredOutputAttemptPlan {
  readonly sessionMode: OpenCodeStructuredOutputSessionMode;
  readonly structuredMode: OpenCodeStructuredOutputMode;
}

/**
 * call() 1回分の構造化出力リカバリ状態。attempt をまたいで持ち回る。
 *
 * nativeDegraded（native → formatless への劣化）と staleSessionRecoveryUsed
 * （resume セッションの stale StructuredOutput 呼び出し救済）は排他的な
 * シナリオ（前者は schema ありの step、後者は schema なしの step でしか
 * 起こらない）だが、予算はそれぞれ独立して「1 call() あたり最大1回」に絞る。
 */
export interface OpenCodeStructuredOutputRecoveryState {
  readonly hasOutputSchema: boolean;
  readonly nativeDegraded: boolean;
  readonly staleSessionRecoveryUsed: boolean;
}

export function createStructuredOutputRecoveryState(
  hasOutputSchema: boolean,
): OpenCodeStructuredOutputRecoveryState {
  return { hasOutputSchema, nativeDegraded: false, staleSessionRecoveryUsed: false };
}

/**
 * 今回の attempt で使うセッション/構造化出力方針を決める純粋関数。
 *
 * - hasInitialSessionId が false（call() の最初からセッション未指定）なら、
 *   呼び出し元は resume を意図していないため常に fresh。
 * - nativeDegraded / staleSessionRecoveryUsed のどちらかが立っていれば、
 *   汚染済みセッションを引きずらないよう以降の attempt も常に fresh を強制する
 *   （transient retry が続いても resume には戻さない）。
 */
export function planStructuredOutputAttempt(
  state: OpenCodeStructuredOutputRecoveryState,
  hasInitialSessionId: boolean,
): OpenCodeStructuredOutputAttemptPlan {
  const mustForceFresh = state.nativeDegraded || state.staleSessionRecoveryUsed;
  const sessionMode: OpenCodeStructuredOutputSessionMode =
    !hasInitialSessionId || mustForceFresh ? 'fresh' : 'resume';
  const structuredMode: OpenCodeStructuredOutputMode = state.nativeDegraded
    ? 'formatless'
    : state.hasOutputSchema
      ? 'native'
      : 'plain';
  return { sessionMode, structuredMode };
}

const NATIVE_FORMAT_PARAMETER_NAMES = ['tool_choice', 'response_format', 'json_schema'];
const REQUEST_REJECTION_MARKERS = [
  'invalid_request_error',
  'badrequest',
  'invalid parameter',
  'not supported',
  'does not support',
];

// "Unsupported parameter: '<name>'" names the single rejected parameter explicitly.
// It takes precedence over the co-occurrence check below: when a message says which
// parameter was rejected, that name — not the mere presence of a format-parameter
// substring elsewhere in the message (e.g. in a "valid parameters" list) — decides
// the verdict. Otherwise a message like "Unsupported parameter: 'seed'. Valid
// parameters include ... response_format, tool_choice ..." would false-positive.
const UNSUPPORTED_PARAMETER_PATTERN = /unsupported parameter:\s*['"`]?([\w.]+)/i;

/**
 * native format の要求そのものが失敗したことを示すエラー文言の判定。
 * StructuredOutput ツールを一度も呼ばなかった場合と、ゲートウェイ/モデルが
 * json_schema 応答形式そのものを拒否した場合の2パターンを拾う。
 */
export function isNativeStructuredOutputFailureMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes('did not produce structured output') || lower.includes('upstream request failed');
}

/**
 * プロバイダが format 由来のパラメータ（強制 tool_choice、response_format /
 * json_schema）をリクエストごと拒否したことを示すエラー文言の判定。
 * パラメータ名だけではファイルパスやツール名にも現れうるため、
 * リクエスト拒否を示す文言が併記されている場合に限る。
 * "Unsupported parameter: '<name>'" 形式は拒否対象そのものを明示するので、
 * その判定を co-occurrence チェックより優先する: <name> が format パラメータで
 * なければ、メッセージ中に response_format 等の文言が別の理由（有効なパラメータ
 * 一覧など）で同居していても false を返す。
 */
export function isNativeFormatRejectionMessage(message: string): boolean {
  const named = UNSUPPORTED_PARAMETER_PATTERN.exec(message)?.[1]?.toLowerCase();
  if (named !== undefined) {
    return NATIVE_FORMAT_PARAMETER_NAMES.includes(named);
  }

  const lower = message.toLowerCase();
  return (
    NATIVE_FORMAT_PARAMETER_NAMES.some((name) => lower.includes(name))
    && REQUEST_REJECTION_MARKERS.some((marker) => lower.includes(marker))
  );
}

/**
 * native → formatless への劣化を1回だけ許可するかどうか。
 * schema を要求していない step（plain）や、既に劣化済みの attempt では発火しない。
 * ツールガード由来の失敗はファイルパスやツール名を文言に埋め込むため、
 * プロバイダ拒否の判定には使わない。
 */
export function shouldDegradeToFormatless(
  state: OpenCodeStructuredOutputRecoveryState,
  failureMessage: string,
  fromToolGuard: boolean,
): boolean {
  if (!state.hasOutputSchema || state.nativeDegraded) return false;
  return isNativeStructuredOutputFailureMessage(failureMessage)
    || (!fromToolGuard && isNativeFormatRejectionMessage(failureMessage));
}

export function degradeToFormatless(
  state: OpenCodeStructuredOutputRecoveryState,
): OpenCodeStructuredOutputRecoveryState {
  return { ...state, nativeDegraded: true };
}

/**
 * resume したセッションに残る過去の StructuredOutput 成功履歴を、モデルが
 * 今回の attempt（schema 要求なし = format なし）でも呼び直してしまうケースの
 * 救済判定。
 *
 * 呼ばれたツールが正確に StructuredOutput で、かつ resume セッションでの
 * attempt に限る。formatless 劣化後の attempt は plan.sessionMode が既に
 * 'fresh'（呼び出し側で強制済み）になっているため、ここでは自然に対象外になる
 * ＝ 劣化後にまた StructuredOutput ループへ落ちたら fail-fast する。
 */
export function shouldRecoverStaleSession(
  state: OpenCodeStructuredOutputRecoveryState,
  plan: OpenCodeStructuredOutputAttemptPlan,
  rejectedTool: string | undefined,
): boolean {
  return (
    !state.hasOutputSchema
    && !state.staleSessionRecoveryUsed
    && plan.sessionMode === 'resume'
    && rejectedTool === STRUCTURED_OUTPUT_TOOL_NAME
  );
}

export function recoverStaleSession(
  state: OpenCodeStructuredOutputRecoveryState,
): OpenCodeStructuredOutputRecoveryState {
  return { ...state, staleSessionRecoveryUsed: true };
}

/**
 * フォーマットなし attempt 用プロンプト。StepExecutor.buildPhase1Instruction
 * （providerSupportsStructuredOutput === false のケース）と同じテンプレート
 * （structured_json_schema_instruction）を使う。テンプレート側に
 * 「StructuredOutput ツールは呼ぶな」の一文を持たせてあるため、ここでは
 * instruction 本文とスキーマを渡すだけでよい。
 */
export function buildFormatlessStructuredPrompt(
  prompt: string,
  schema: Record<string, unknown>,
  lang: Language = 'en',
): string {
  return buildStructuredJsonSchemaInstruction(prompt, schema, lang);
}
