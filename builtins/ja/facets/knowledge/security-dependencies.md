# 依存関係セキュリティ知識

## 適用条件

dependency または lockfile entry を追加・削除・解決・設定・更新する変更に適用する。

## 脆弱性の到達可能性

CVE、advisory、maintenance 状態だけでは、変更が悪用可能な経路を導入したことを示さない。関連する link をすべて確認する。

- 差分で変わる正確な resolved version
- 一次 advisory または vendor source が示す affected version range
- この project から到達する脆弱な package function または runtime feature
- 脆弱性に必要な低信頼入力、主体の access、deployment mode、platform、設定
- 到達する機能が実行される権限と保護資産
- 変更が affected version を導入するか、関連経路を変更していないか

いずれかの link が欠ける場合、package 名から悪用可能性を推測せず、未確認の内容を記録する。resolved version、affected range、到達可能な機能、攻撃前提、具体的影響を立証できる場合、実害を再現せずに dependency と call path の静的証拠でセキュリティ経路を示せる。

## Integrity と解決

registry、lockfile、checksum、install script、build plugin、source reference では、resolved artifact の制御主体、保護する検証、code が実行される時点、build・runtime 権限を特定する。新規 dependency の必要性や maintenance 品質は、確認済みの integrity・実行経路を作らない限り、それ自体ではセキュリティ境界にならない。
