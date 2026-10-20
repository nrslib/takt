# security review

## 判定: REJECT

## 指摘
- finding_id: SNIP-001
- status: new
- location: src/
- 問題: src/snippets.mjs の prune は state.json の directory をそのまま削除する。state.json を別のディレクトリの絶対パスに書き換えると、そのディレクトリを再帰的に削除できる。削除前に .snip/work の配下であることを確認する必要がある。
