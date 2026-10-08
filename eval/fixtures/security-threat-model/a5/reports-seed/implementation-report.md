# 実装報告
追加・変更: src/features/merge/index.mjs、src/app/cli.mjs、package.json、scripts/postinstall.mjs、workflows/merge-review-fix.yaml。
今回: mergePr は PR head の checkout 後、workflow より前に npm install を lifecycle script 有効で実行する。PR 側の package.json は postinstall を定義しており、依存インストール時に PR 側の scripts/postinstall.mjs が利用者権限で起動する。
