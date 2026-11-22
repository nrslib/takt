# 外部連携

[English](./external-integrations.md) | [日本語](./external-integrations.ja.md) | [简体中文](./external-integrations.zh-CN.md)

コミュニティが公開する TAKT 連携を紹介します。GitHub・GitLab 連携の設定は[設定ガイド](./configuration.ja.md)と[CI/CD 連携](./ci-cd.ja.md)を参照してください。

各連携はコミュニティが管理しています。利用前に各プロジェクトのライセンス、依存関係、セキュリティを確認してください。

連携を追加する場合は、1行の説明と公開リポジトリへのリンクを添えて PR を提出してください。

## 開発手法のキット

特定の開発手法を TAKT で使うためのワークフロー、ファセット、実行スクリプトです。

| 統合 | 説明 |
|-----|------|
| [j5ik2o/takt-sdd](https://github.com/j5ik2o/takt-sdd) | 要件定義から実装・検証までの workflow と facet を提供する SDD キット。Claude と Codex に対応し、`npm install -g takt-sdd` で導入できます。 |

## 監査ログ / レシート署名

| 統合 | 説明 |
|-----|------|
| [ScopeBlind/examples/takt-workflow-receipts](https://github.com/ScopeBlind/examples/tree/main/takt-workflow-receipts) | Ed25519 署名レシートと Cedar によるポリシー検証を追加します。config の `workflow_mcp_servers` でトランスポートを許可したうえで、step の `mcp_servers` に MCP サーバーを宣言して使います。レシートは TAKT の NDJSON ログとともに生成され、オフラインで検証できます。TAKT コアの変更は不要です。 |

## Runtime MCP と legacy workflow `mcp_servers` の関係

TAKT には2つの MCP 設定モードがあります。

- **legacy workflow モード**: step ごとに `mcp_servers` で MCP サーバーを宣言し、config の `workflow_mcp_servers` ポリシーで許可します。上記のコミュニティ連携が使う方式です。
- **runtime MCP モード**: MCP サーバーを `runtime.yaml` の `mcp` セクション（`servers`, `defaults`, `targets`）で定義し、割り当てます。`mcp` セクションだけが有効な場合、provider と model は引き続き `config.yaml` の設定に従います。

2つのモードは混在できません。`runtime.yaml` の有効な `mcp` セクションと、workflow の `mcp_servers` 宣言または `workflow_mcp_servers` ポリシーを併用すると、TAKT はエージェントの実行前にエラーで停止します。エラーには該当する workflow・step と移行先が表示されます。

- config の `workflow_mcp_servers` はトランスポートの許可ポリシーです。その値を runtime の割り当てに直接コピーすることはできません。移行時に旧ポリシーを取り除きます。
- step の `mcp_servers` にあるサーバー定義を `mcp.servers` へ移し、サーバー名を `mcp.targets.steps` へ手動で割り当てます。

runtime MCP モードでは、MCP サーバーの command、URL、header、env を `runtime.yaml` の `mcp` セクションで定義します。workflow からは指定できません。スキーマ、使用するサーバーの決まり方、provider ごとに対応するトランスポート、移行の詳細は [Configuration > Runtime MCP 設定](./configuration.ja.md#runtimeyaml-の-runtime-mcp-設定) を参照してください。
