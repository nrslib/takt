`caccia-decisions.json` には有効な JSON オブジェクトだけを書きます。Markdown のコードフェンスや前後の説明文を付けません。

```json
{
  "outcome": "complete",
  "reason": "この反復を完了した理由、または中止が必要な理由",
  "decisions": [
    {
      "thread_id": "渡された thread ID をそのまま記載",
      "valid": true,
      "reason": "どのコード契約に反し、何を変更したか"
    }
  ]
}
```

`outcome` は `complete` または `abort` にします。`reason` は反復全体の理由です。`abort` の場合は空でない文字列を必須とし、各 decision の理由で代用しません。

すべての対象スレッドに重複なく判断を1件ずつ記録し、妥当な指摘をすべて修正した場合だけ `complete` にします。古いスレッドや妥当でない指摘も含めます。安全に対処できない指摘がある場合や PR の目的自体を見直す必要がある場合は `abort` とし、妨げとなる事情を全体の `reason` に記載します。中止時の `decisions` には実際に判断できた項目だけを含め、未判断のスレッドを修正済みや `valid: false` として埋めません。

各 decision には渡された `thread_id`、JSON boolean の `valid`、コード上の根拠を含む空でない `reason` を記録します。今回修正した妥当な指摘だけを `valid: true` にします。不具合ではない指摘や PR の目的に反する指摘は `valid: false` とし、理由を記載します。重複・対象外の ID、コメント、返信、その他のスレッド本文は含めません。
