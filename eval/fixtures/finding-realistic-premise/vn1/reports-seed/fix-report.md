# 修正報告

## 結果: 修正完了

## 完了義務
| 義務 | 対象 | 受入条件 | 証拠 |
|------|------|----------|------|
| R-1-1 | src/summary.mjs | 台帳の全件の金額を合計し、件数を返す。空の台帳は件数0と合計0を返す。 | 現在のコード、test/summary.test.mjs、test/empty.test.mjs |

## 品質ゲート
- node --test test/summary.test.mjs: 終了コード 0、tests 1, pass 1, fail 0。
- node --test test/empty.test.mjs: 終了コード 0、tests 1, pass 1, fail 0。
上記は現在のコードと指定の条件で実行した。その後に src/summary.mjs と対象の2テストの変更はない。

## 実行記録
src/report.mjs の各行に id を付ける変更を行い、test/report.test.mjs の期待値も更新した。この変更は docs/change.patch と現在の src/report.mjs に残っている。
