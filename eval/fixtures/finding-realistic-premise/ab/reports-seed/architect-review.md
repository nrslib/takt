# architecture review

## 判定: REJECT

## 指摘
- finding_id: LIST-002
- status: new
- location: src/
- 問題: src/list.mjs は git ls-files logs/ の出力を execFileSync の既定の1MiB上限で受ける。docs/daily-manifest.json の30000件と各パスの長さから出力は2MiBを超え、文書が定める1日分の一覧が例外で失敗する。定めた件数を扱える取得方法にする必要がある。
