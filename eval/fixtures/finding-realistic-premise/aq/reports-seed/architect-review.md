# architecture review

## 判定: REJECT

## 指摘
- finding_id: LIST-001
- status: new
- location: src/
- 問題: src/list.mjs は execFileSync の既定の出力上限を使う。notes/ の出力が1MiBを超える件数を登録すると一覧が例外で失敗する。出力量を制限するか逐次取得する必要がある。
