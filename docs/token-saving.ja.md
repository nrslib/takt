# トークン節約ガイド

[English](./token-saving.md)

トークン節約は、まず baseline を測ってから行います。トークン数が減っても、retry、loop 回数、所要時間、provider cost が増えるなら改善ではありません。

## まず計測する

phase-level usage events を有効化します。

```yaml
observability:
  enabled: true
  usage_events_phase: true
```

TAKT を build し、run を分析します。

```bash
npm run build
npm run analyze:usage -- .takt/runs/<run>
```

`step`、`phase`、`provider`、`model` ごとに比較します。workflow を変更する前に、review loop の繰り返し、大きな `phase1_execute` prompt、usage 欠落を確認してください。

## Workflow のコストを下げる

- フルの plan/review loop が不要な task では、`*-mini` など軽量な builtin workflow を選びます。
- `provider_routing` で低リスクな step を安価または高速な provider/model に振り分けます。
- 高価な model は final review や難しい implementation step など、必要な step だけに使います。
- 大きすぎる task は TAKT 実行前に分割し、planning/review context を小さくします。
- 詳細な文章が不要な report では output contract を短くします。

## Context を絞る

- persona、policy、knowledge、instruction は、それを使う step に必要な範囲へ絞ります。
- 1つの step だけが必要とする大きな knowledge file を全 step に共有しないでください。
- 長い背景情報の貼り付けより、task 固有の事実を優先します。
- 参照されなくなった workflow-local facet は削除します。

## 外部圧縮 proxy を評価する

外部圧縮 proxy は baseline usage を把握した後に評価します。導入前後の TAKT usage events を比較し、利用できる場合は provider 側または proxy 側の統計も比較してください。raw token が減っても retry、review reject、総コストが増えるなら、その proxy は効果がありません。

