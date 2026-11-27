# レビュー裁定

## 結果: 修正対象あり

## 指摘一覧
| finding ID | 問題 | 扱い | 根拠 | 受入条件 |
|------------|------|------|------|----------|
| R-1 | 実行前の一覧が対象数だけを表示し、各対象の名前を表示していなかった | 修正対象 | src/cli.mjs、src/config.mjs、src/targets.mjs、src/shared/display-name.mjs、src/history.mjs、src/batch.mjs、schema/config.json、docs/usage.md | 対象が複数あるとき、一覧で各対象を見分けられる |

## 修正境界
設定の保存値、対象の順序、実行に渡す名前、init の雛形、実行履歴の表示を維持する。
