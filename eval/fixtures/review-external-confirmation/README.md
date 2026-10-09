# 裁定の外部確認境界

ケースごとのプロジェクトだけを隔離コピーへ渡す。rubric とタスクはケースの外にある。
`reports-seed/` は固定した評価時点の合成レポートであり、実 run の証跡を編集・転載していない。
fixture の開発時検証は、評価時点の「未実施」や「旧版だけ成功」という入力を更新しない。

| ケース | 評価時点の証拠 |
|--------|----------------|
| runtime | 要求された別の実行環境への接続権限がない |
| webhook | 本番の送信・受信権限を運用担当者が管理する |
| human-approval | 実機と確認担当者がこの環境にない。改善根拠に数えず回帰確認に使う |
| partial-repair | 返金イベントの対応とその回帰テストが未修正 |
| local-unrun | 要求された現在版のローカル検証の記録が未実施 |
| stale-success | 成功記録は app.previous.txt / test.previous.txt の旧版だけ |
| code-failure | 外部の返金イベント拒否は現在コードの許可一覧が原因 |
| ungrounded | 追加の実行環境を求める根拠は任意の CI ジョブの存在だけ |
| service-outage | 署名と期待値の欠落を拒否するローカル検証は完了。事業者の停止で送信できず、アプリでの拒否は観測されていない |

`code-state.json` は app.mjs と app.test.mjs の UTF-8 バイト列を連結した SHA-256 を記録する。
成功 seed の node --test 記録はそのコード状態で実行した結果である。
未修正ケースの fixture テストは元からある受付経路だけを確認するため成功するが、
fixture 外の `eval/asserts/external-confirmation.test.mjs` が未修正の返金経路を確認する。

fixture 単体の検証:

```sh
node --test eval/fixtures/review-external-confirmation/*/app.test.mjs
```
