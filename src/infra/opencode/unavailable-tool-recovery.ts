/**
 * OpenCode のエラー文 "Model tried to call unavailable tool 'X'. Available
 * tools: a, b, c." から、サーバが申告する利用可能ツール一覧を取り出す。
 * 'invalid' はサーバ内部の不正呼び出しルーティング用擬似ツール（1.17.18 が
 * 自身の列挙に含めてくるが、モデルが呼ぶべきものではない）なので除外する。
 * 形式が変わって解析できない場合は undefined とし、利用可能ツール一覧を
 * 断定しない。
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
