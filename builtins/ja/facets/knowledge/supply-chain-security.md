# ソフトウェア・サプライチェーンのセキュリティ知識

依存関係と artifact の信頼境界をレビューする。

- dependency 宣言、lockfile、registry と source の選択、integrity metadata、transitive update
- install、prepare、build、test、publish script による code 実行と artifact 変更
- package provenance、release permission、生成 artifact、signing、環境間の promotion
- dependency confusion、typosquatting、pin されていない入力、build tooling の未レビュー変更

各指摘をリポジトリの dependency、build、release 経路に結び付ける。無関係な application 挙動を supply-chain 指摘に変えない。
