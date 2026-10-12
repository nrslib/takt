# 外部連携

[English](./external-integrations.md) | [日本語](./external-integrations.ja.md) | [简体中文](./external-integrations.zh-CN.md)

コミュニティが公開する TAKT 連携を紹介します。GitHub・GitLab 連携の設定は[設定ガイド](./configuration.ja.md)と[CI/CD 連携](./ci-cd.ja.md)を参照してください。

各連携はコミュニティが管理しています。利用前に各プロジェクトのライセンス、依存関係、セキュリティを確認してください。

連携を追加する場合は、1行の説明と公開リポジトリへのリンクを添えて PR を提出してください。

## メソドロジーキット

特定の開発手法を TAKT で使うためのワークフロー、ファセット、実行スクリプトです。

| 統合 | 説明 |
|-----|------|
| [j5ik2o/takt-sdd](https://github.com/j5ik2o/takt-sdd) | 要件定義から実装・検証までの workflow と facet を提供する SDD キット。Claude と Codex に対応し、`npm install -g takt-sdd` で導入できます。 |

## 監査ログ / レシート署名

| 統合 | 説明 |
|-----|------|
| [ScopeBlind/examples/takt-workflow-receipts](https://github.com/ScopeBlind/examples/tree/main/takt-workflow-receipts) | step の `mcp_servers` で MCP サーバーを宣言する形で Ed25519 署名レシートと Cedar ポリシー検証を追加する（事前に config の `workflow_mcp_servers` でトランスポートの許可が必要）。レシートは TAKT の NDJSON ログと並んで生成され、オフラインで検証可能。TAKT コアの変更不要。 |

## Runtime MCP と legacy workflow `mcp_servers` の関係

TAKT には2つの MCP 設定モードがあります。

- **legacy workflow モード**: step ごとに `mcp_servers` で MCP server を宣言し、`workflow_mcp_servers` config ポリシーで許可します。上記コミュニティ統合が使う方式です。
- **runtime MCP モード**: MCP server を `runtime.yaml` の `mcp` セクション（`servers`, `defaults`, `targets`）で定義・割り当てます。`mcp` セクションだけが有効な場合、provider/model 解析は `config.yaml` のままです。

2つのモードは混在できません。`runtime.yaml` の有効な `mcp` セクションが workflow の `mcp_servers` 宣言や `workflow_mcp_servers` ポリシーと共存する場合、TAKT は agent 実行前に fail-fast し、該当 workflow/step と移行先を報告します。

- workflow の `mcp_servers` ポリシー → `mcp.targets`
- step の `mcp_servers` マップ → `mcp.targets.steps`

runtime MCP モードでは、workflow から MCP server の command、URL、header、env を指定できません。これらは `runtime.yaml` の `mcp` セクションが所有します。スキーマ、実効 server 解決、provider 別 transport 対応、移行の詳細は [Configuration > Runtime MCP 設定](./configuration.ja.md#runtimeyaml-の-runtime-mcp-設定) を参照してください。
