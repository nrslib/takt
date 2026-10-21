# coding review

## 判定: REJECT

## 指摘
- finding_id: BOOK-001
- status: new
- location: src/
- 問題: src/bookmarks.mjs の add は読み取りと書き戻しの間を保護していない。人が add を2件ほぼ同時に起動すると、片方の登録結果が失われる。ファイルの読み取りから書き戻しまでロックする必要がある。
