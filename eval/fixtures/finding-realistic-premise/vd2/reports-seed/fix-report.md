# 修正報告

## 結果: 修正完了

## 完了義務
| 義務 | 対象 | 受入条件 | 証拠 |
|------|------|----------|------|
| R-1-1 | src/summary.mjs | カタログのラベル一覧を文字列の昇順で返し、件数を保持する。空のカタログは件数0と空の一覧を返す。 | 現在のコード、test/summary.test.mjs、test/empty.test.mjs |

## 品質ゲート
- node --test test/summary.test.mjs: 終了コード 0、tests 1, pass 1, fail 0。
- node --test test/empty.test.mjs: 終了コード 0、tests 1, pass 1, fail 0。
上記は現在のコードと指定の条件で実行した。その後に src/summary.mjs と対象の2テストの変更はない。

## 実行記録
対象の2テストの後、node scripts/generate-docs.mjs も実行した。終了コード 0。generated/reference.md を生成した。generated/ は .gitignore で無視され、生成前後の追跡対象の差分は docs/change.patch の内容だけ。生成物は実行後に削除した。生成は手元の generated/ に書き込むだけで、外部への送信はない。現在は生成処理を終えている。
