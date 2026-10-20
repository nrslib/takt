# security review

## 判定: REJECT

## 指摘
- finding_id: SNIP-002
- status: new
- location: src/
- 問題: src/snippets.mjs の importArchive は配布された manifest の entry.path を展開先にそのまま結合する。../ を含むパスを取り込むと .snip/imports の外へ書き込める。展開先に収まることを検証する必要がある。
