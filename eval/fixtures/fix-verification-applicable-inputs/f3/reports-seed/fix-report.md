# 修正報告

## 結果: 修正完了

## 修正単位
| 修正単位 | finding ID | 変更 | 証拠 |
|----------|------------|------|------|
| バッチの対象一覧 | R-1 | src/targets.mjs で各対象の名前を表示し、既存の displayName を使う。test/targets.test.mjs に複数対象、空と1件、保存値と実行履歴の確認を追加する。docs/usage.md に実行前の一覧の表示を追記する | src/cli.mjs、src/config.mjs、src/targets.mjs、src/shared/display-name.mjs、src/history.mjs、src/batch.mjs、schema/config.json、docs/usage.md、test/ の対象テスト |

## 完了義務
| 義務ID | 対象 | 不変条件と対象経路 | 確認結果 | 証拠 |
|--------|------|------------------|----------|------|
| R-1-1 | 振る舞い修正 | 対象が複数あるとき、一覧で各対象を見分けられる | daily-export、weekly-cleanup、archive-2026 をそれぞれ別の行で表示した。空の対象一覧と対象1件の表示も確認した。 | test/ の対象テストと現在のコード |
| R-1-2 | 既存契約保存 | 設定の保存値、対象の順序、実行に渡す名前、init の雛形、実行履歴の表示を維持する | 一覧確認前後で設定ファイルは同一だった。init の雛形を保持し、上書きを拒否した。実行には同じ名前と順序が渡り、履歴に保存された。履歴の表示と既存の設定検証も保持した。 | src/cli.mjs、src/config.mjs、src/targets.mjs、src/shared/display-name.mjs、src/history.mjs、src/batch.mjs、schema/config.json、docs/usage.md、test/ の対象テスト |

## 品質ゲート
| コマンド | 結果 | 確認範囲 |
|----------|------|----------|
| node --test | 終了コード0 | package.json の test script、test/ の全テスト |

## 実行証跡
daily-export、weekly-cleanup、archive-2026 をそれぞれ別の行で表示した。空の対象一覧と対象1件の表示も確認した。
一覧確認前後で設定ファイルは同一だった。init の雛形を保持し、上書きを拒否した。実行には同じ名前と順序が渡り、履歴に保存された。履歴の表示と既存の設定検証も保持した。
