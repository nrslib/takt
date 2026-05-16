# External Integrations

TAKT のコアを変更せずに機能を拡張する、コミュニティメンテナンスのサンプル集です。TAKT として公式にサポート・推奨するものではありません。各プロジェクトのライセンス、依存関係、セキュリティ面を必ず確認した上で利用してください。

ここに追加したい場合は、1 行の説明とパブリックリポジトリへのリンクを添えて PR を送ってください。

## メソドロジーキット

TAKT 上に特定の開発手法を実装した bundle。ピース・ファセット・実行スクリプトをまとめて 1 コマンドで導入できます。

| 統合 | 説明 |
|-----|------|
| [j5ik2o/takt-sdd](https://github.com/j5ik2o/takt-sdd) | TAKT 向けの Spec-Driven Development (SDD) メソドロジーキット。要件定義 → ギャップ分析 → 設計 → タスク分解 → 実装 → 検証 の各フェーズをピースとして提供し、OpenSpec 形式の変更提案フローも同梱。TAKT のフェーズゲート / output contract / レビューループに乗ることで、しっかり定義された spec はそのまま忠実な実装に変換されます。フェーズを暗黙にスキップさせず、逸脱は `fix` に戻ります。Claude / Codex 両対応。`npx create-takt-sdd` でインストール。 |

## 監査ログ / レシート署名

| 統合 | 説明 |
|-----|------|
| [ScopeBlind/examples/takt-workflow-receipts](https://github.com/ScopeBlind/examples/tree/main/takt-workflow-receipts) | `mcp_servers` で MCP サーバーを宣言する形で Ed25519 署名レシートと Cedar ポリシー検証を追加する。レシートは TAKT の NDJSON ログと並んで生成され、オフラインで検証可能。TAKT コアの変更不要。 |
