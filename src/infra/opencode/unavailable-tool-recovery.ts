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
  /**
   * サーバのエラー文（"Available tools: ..."）から実測した利用可能ツール一覧。
   * TAKT の写像ではなくサーバ申告を正とする — v3-r4 では写像由来の一覧が
   * 実在しない 'list' を「利用可能」と再誘導し、fresh session 後も同名再発で
   * 確定失敗した。内部擬似ツール 'invalid' は除外済み。
   */
  readonly serverAvailableTools?: readonly string[];
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
  serverAvailableTools?: readonly string[],
): UnavailableToolRecoveryState {
  return { ...state, used: true, tool, ...(serverAvailableTools ? { serverAvailableTools } : {}) };
}

/**
 * OpenCode のエラー文 "Model tried to call unavailable tool 'X'. Available
 * tools: a, b, c." から、サーバが申告する利用可能ツール一覧を取り出す。
 * 'invalid' はサーバ内部の不正呼び出しルーティング用擬似ツール（1.17.18 が
 * 自身の列挙に含めてくるが、モデルが呼ぶべきものではない）なので除外する。
 * 形式が変わって解析できない場合は undefined（呼び出し側が写像由来の一覧へ
 * フォールバックする）。
 */
const SERVER_TOOL_NAME_PATTERN = /^[a-z][a-z0-9_-]*$/i;

export function parseServerAvailableTools(message: string): string[] | undefined {
  // 列挙はメッセージ末尾（終端ピリオドは任意）まで丸ごと取る。`[^.]+` は
  // "foo.bar, read." を "foo" に切り詰めて解析成功と誤認する（codex 指摘）。
  const match = /Available tools:\s*(.+?)\.?\s*$/i.exec(message);
  const body = match?.[1];
  if (!body) {
    return undefined;
  }
  const tokens = body.split(',').map((token) => token.trim());
  // 全トークンをツール名文法で検証し、1件でも契約外なら列挙全体を破棄する。
  // "bash; read" のような壊れトークンや、"none"（列挙なしの明示であって
  // ツール名ではない）を解析成功として返さない。
  if (tokens.length === 0) {
    return undefined;
  }
  if (tokens.some((token) => !SERVER_TOOL_NAME_PATTERN.test(token) || token.toLowerCase() === 'none')) {
    return undefined;
  }
  // 'invalid' はサーバ内部の擬似ツール（大文字小文字不問で除外）。
  const tools = tokens.filter((token) => token.toLowerCase() !== 'invalid');
  return tools.length > 0 ? tools.sort() : undefined;
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
  // v3-r4 実測: opencode 1.17.18 に 'list' は存在しない（削除。'ls' でもない）。
  // ディレクトリ一覧の具体的な代替へ誘導する。
  ['list', { target: 'glob', hint: 'There is no "list" tool. To list directory contents, use "glob" (e.g. pattern "*" under the target path) or run `ls` via the "bash" tool.' }],
  ['ls', { target: 'bash', hint: 'There is no "ls" tool. Run `ls` via the "bash" tool, or use "glob" to enumerate files.' }],
]);


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
  serverAvailableTools: readonly string[] | undefined,
): string {
  const alias = KNOWN_TOOL_ALIAS_HINTS.get(invalidTool.toLowerCase());
  // エイリアス案内は変換先ツールがこの attempt で有効な場合だけ出す。
  // 例: allowed_tools に bash が無いレビュー系ステップで 'run' が発火した
  // とき、無条件に「Use "bash"」と案内すると有効一覧（bash なし）と矛盾し、
  // 唯一の救済 attempt を誤誘導する。サーバ申告一覧が取れないときは検証の
  // しようがないため、既知エイリアスの案内はそのまま出す（標準ツールへの
  // 誘導であり、誤誘導リスクより価値が大きい）。
  const aliasHint = alias !== undefined && (serverAvailableTools === undefined || serverAvailableTools.includes(alias.target))
    ? alias.hint
    : undefined;
  // 「利用可能ツールの完全一覧」はサーバ申告（エラー文の Available tools）が
  // 解析できたときだけ断定する。TAKT の静的写像はワイヤ専用 ID や旧バージョン
  // 互換の ID を含み、完全一覧としては誇大宣伝になる（codex 指摘）。
  return loadTemplate('parts/unavailable_tool_retry_instruction', 'en', {
    instruction: prompt,
    invalidTool: JSON.stringify(invalidTool),
    validTools: serverAvailableTools !== undefined ? serverAvailableTools.join(', ') : false,
    noServerToolList: serverAvailableTools === undefined,
    aliasHint: aliasHint ?? false,
  });
}
