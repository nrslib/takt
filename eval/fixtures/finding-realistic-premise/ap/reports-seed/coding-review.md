# coding review

## 判定: REJECT

## 指摘
- finding_id: BOOK-002
- status: new
- location: src/
- 問題: src/bookmarks.mjs の sync は Promise.all で各ジョブが同じ bookmarks.json を読み取り、追加し、書き戻す。--jobs 2 で同じ内容を読んだ2処理が書き戻すと一方の追加が残らない。全件の登録を保持する必要がある。
