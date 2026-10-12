# トークン節約ガイド

[English](./token-saving.md)

まず現在の使用量を測ります。トークン数だけでなく、再試行・ループの回数、所要時間、利用料金も比較してください。

## まず計測する

フェーズごとの使用量イベントを有効にします。

```yaml
observability:
  enabled: true
  usage_events_phase: true
```

TAKT をビルドして実行記録を分析します。

```bash
npm run build
npm run analyze:usage -- .takt/runs/<run>
```

`step`、`phase`、`provider`、`model` ごとに比較します。workflow を変更する前に、レビューの反復、大きな `phase1_execute` プロンプト、使用量記録の欠落を確認してください。

## Workflow のコストを下げる

- 計画やレビューの工程を絞れるタスクには `*-mini` などの軽量な組み込み workflow を選びます。
- runtime 設定の `provider.targets`、または旧設定の [`provider_routing`](./configuration.ja.md) で step ごとに provider と model を選びます。
- 高コストの model は難しい実装や最終レビューなど、必要な step に使います。
- 大きなタスクは実行前に分割し、計画とレビューに渡す文脈を絞ります。
- 詳細な文章が不要なレポートでは output contract を簡潔にします。

## Context を絞る

- persona、policy、knowledge、instruction は、それを使う step に必要な範囲へ絞ります。
- 1つの step で使う長い knowledge ファイルは、その step にだけ渡します。
- 長い背景説明より、タスク固有の事実を優先します。
- 参照されなくなった workflow-local facet は削除します。

## 外部圧縮 proxy を評価する

外部の圧縮プロキシを導入する前後で TAKT の使用量イベントを比較します。利用できる場合は provider やプロキシの統計も確認してください。トークン数とともに再試行、レビューでの差し戻し、総費用の変化を評価します。
