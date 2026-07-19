/**
 * 'list' 互換シム（plugins/list-tool.ts）の upstream 衝突ガード。
 *
 * Finding Contract: upstream の registry に 'list' が実在する環境では登録しない
 * （fail-closed。「custom が上書きするから問題ない」は不可）。実装はバージョン
 * allowlist を採る:
 * - プラグイン初期化中に自サーバの /experimental/tool/ids を引くと deadlock
 *   する（実測: プラグイン init が tool 列挙をブロックし fetch がタイムアウト）
 * - TAKT 側で server 起動後に tool.ids を引く方式は、plugin を config で
 *   起動前に確定させる必要があるため再起動が要る（共有サーバプールの寿命
 *   管理を複雑化する）
 *
 * allowlist は「registry に 'list' が無いことを実測済みのバージョン」のみを
 * 許可し、未知のバージョン（将来の minor 以降）や検出失敗は fail-closed で
 * 登録しない。1.17.18 と 1.18.2 の実測 registry: invalid, question, bash, read, glob,
 * grep, edit, write, task, webfetch, todowrite, websearch, skill, apply_patch
 * （'list' なし）。
 */

/**
 * opencode バイナリのバージョンがシム登録を許可する範囲か。
 * 1.17.18 と 1.18.2 で 'list' 不在を実測済み。1.17 系（>= .18）と、依存を
 * 固定して実測した1.18.2のみ許可し、それ以外は再検証まで fail-closed。
 */
export function versionAllowsListToolShim(version: string): boolean {
  // 末尾アンカー付きの厳密形。"1.17.18-beta.1" / "1.17.18junk" / "1.17.18.1" の
  // ような亜種は未検証バージョンとして fail-closed（boundary requirement: アンカー無しだと
  // 全部許可されていた）。
  const normalized = version.trim();
  if (normalized === '1.18.2') {
    return true;
  }
  const match = /^1\.17\.(\d+)$/.exec(normalized);
  if (!match) {
    return false;
  }
  return Number(match[1]) >= 18;
}

/**
 * registry の tool ID 一覧がシム登録を許可するか（'list' 不在のときだけ true）。
 * 実バイナリに対する統合テストが「allowlist の判定と実 registry が一致している」
 * ことをこの関数で検証する。壊れた入力は fail-closed。
 */
export function registryAllowsListToolShim(toolIds: unknown): boolean {
  return Array.isArray(toolIds)
    && toolIds.length > 0
    && toolIds.every((id) => typeof id === 'string')
    && !toolIds.includes('list');
}
