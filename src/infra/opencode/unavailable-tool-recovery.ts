/**
 * 存在しないツール名（幻覚）の連続呼び出しで attempt が停止したときの
 * bounded recovery。structured-output-recovery.ts の一般ツール版。
 *
 * 背景（実測）: qwen 系が実在しない 'run' を2回連続で呼び、
 * UnavailableToolLoopDetector（閾値2）が発火してステップ失敗 → workflow abort
 * となり、1走行が25分無駄になった。エイリアスツールをプラグインで登録する案は
 * 不採用（OpenCode の公開 API に組み込み bash への転送手段が無く、自前 spawn の
 * 再実装は権限・フック・timeout をバイパスする偽物になるため）。かわりに
 * fresh session + 再試行前置文（幻覚ツール名の指摘・有効ツール一覧・workspace
 * 継続の警告）で1回だけやり直す。
 *
 * StructuredOutput はここでは救済しない: あちらは「resume したセッションの
 * 汚染」という別の病因であり、structured-output-recovery.ts の厳格な条件
 * （resumed + plain + 未使用）でのみ救済する。予算も互いに独立。
 */

import { loadTemplate } from '../../shared/prompts/index.js';
import { STRUCTURED_OUTPUT_TOOL_NAME } from './structured-output-recovery.js';

/** call() 1回分の一般 unavailable-tool recovery 状態。attempt をまたいで持ち回る。 */
export interface UnavailableToolRecoveryState {
  readonly used: boolean;
  /** 発火時の幻覚ツール名。再試行前置文の生成に使う。 */
  readonly tool?: string;
}

export function createUnavailableToolRecoveryState(): UnavailableToolRecoveryState {
  return { used: false };
}

/**
 * 一般 unavailable-tool recovery を発動してよいかの判定。
 *
 * - detector が発火していること（tool が型で渡ってくる）
 * - StructuredOutput ではないこと（stale recovery 専用の厳格な条件に委ねる）
 * - この call() でまだ使っていないこと（1回限り。再試行後も同じ違反なら本物の失敗）
 */
export function shouldRecoverUnavailableToolLoop(
  state: UnavailableToolRecoveryState,
  detectedTool: string | undefined,
): boolean {
  return (
    detectedTool !== undefined
    && detectedTool !== STRUCTURED_OUTPUT_TOOL_NAME
    && !state.used
  );
}

export function markUnavailableToolRecoveryUsed(
  state: UnavailableToolRecoveryState,
  tool: string,
): UnavailableToolRecoveryState {
  return { ...state, used: true, tool };
}

/** 既知エイリアスの変換先ツールと案内文。変換先が実際に使える場合だけ提示する。 */
interface ToolAliasHint {
  readonly target: string;
  readonly hint: string;
}

/**
 * 既知のエイリアス幻覚 → 実在ツールへの案内。
 * 実測で観測された名前だけを載せる。未知の名前に意味推測でマッピングを
 * 付けてはいけない（誤案内は幻覚を強化する）ので、ここにない名前は
 * 有効ツール一覧のみを提示する。プレーンオブジェクトではなく Map を使うのは、
 * 'constructor' のようなプロトタイプ由来のキーを誤ヒットさせないため。
 */
const KNOWN_TOOL_ALIAS_HINTS: ReadonlyMap<string, ToolAliasHint> = new Map([
  ['run', { target: 'bash', hint: 'Use "bash" for shell commands.' }],
  ['todo_write', { target: 'todowrite', hint: 'Use "todowrite" to manage the todo list.' }],
]);

/**
 * buildOpenCodePromptTools() が返す per-prompt tools マップから、有効な
 * ツール名だけを取り出す。前置文の有効ツール一覧は静的な焼き込みではなく
 * 常にこのマップから動的に生成する（phase ごとの制限を正しく反映するため）。
 */
export function listEnabledPromptTools(promptTools: Readonly<Record<string, boolean>>): string[] {
  return Object.entries(promptTools)
    .filter(([, enabled]) => enabled)
    .map(([tool]) => tool)
    .sort();
}

/**
 * 再試行 attempt 用のプロンプトを組み立てる。
 *
 * 幻覚ツール名はモデル出力由来の文字列なので、JSON.stringify で引用・
 * エスケープしてからテンプレートへ埋め込む（改行や引用符でテンプレート
 * 構造を壊さない）。テンプレートは en のみ（opencode agent プロンプトと
 * 同じ前例: client.ts の agent 定義コメント参照）。
 */
export function buildUnavailableToolRetryPrompt(
  prompt: string,
  invalidTool: string,
  enabledTools: readonly string[],
): string {
  const alias = KNOWN_TOOL_ALIAS_HINTS.get(invalidTool.toLowerCase());
  // エイリアス案内は変換先ツールがこの attempt で有効な場合だけ出す。
  // 例: allowed_tools に bash が無いレビュー系ステップで 'run' が発火した
  // とき、無条件に「Use "bash"」と案内すると有効一覧（bash なし）と矛盾し、
  // 唯一の救済 attempt を誤誘導する。使えない変換先なら未知名と同じ扱い
  // （有効一覧のみ提示）に落とす。
  const aliasHint = alias !== undefined && enabledTools.includes(alias.target)
    ? alias.hint
    : undefined;
  return loadTemplate('parts/unavailable_tool_retry_instruction', 'en', {
    instruction: prompt,
    invalidTool: JSON.stringify(invalidTool),
    validTools: enabledTools.join(', '),
    aliasHint: aliasHint ?? false,
  });
}
