```json
{
  "rawDecisions": [
    {
      "rawFindingId": "raw-1",
      "decision": "same",
      "findingId": "F-0001",
      "evidence": "src/foo.ts:42 で同一問題と確認"
    },
    {
      "rawFindingId": "raw-2",
      "decision": "new",
      "findingId": "",
      "evidence": "対応する既存 open finding が無い"
    },
    {
      "rawFindingId": "raw-previous-1",
      "decision": "resolved",
      "findingId": "F-0002",
      "evidence": "src/bar.ts:10 で解消を確認"
    },
    {
      "rawFindingId": "raw-3",
      "decision": "reopened",
      "findingId": "F-0003",
      "evidence": "指摘が再発している"
    },
    {
      "rawFindingId": "raw-4",
      "decision": "conflict",
      "findingId": "F-0005",
      "evidence": "既存の resolved 状態と矛盾する"
    }
  ],
  "disputeDecisions": [
    {
      "findingId": "F-0003",
      "decision": "waive",
      "reason": "公開契約（変更禁止の型定義）が Record を強制しており、hasOwn による遮断が完全な対策であるため",
      "evidence": "src/types.ts:94, src/domain.ts:82"
    },
    {
      "findingId": "F-0004",
      "decision": "note",
      "reason": "coder は仕様起因と主張したが、証跡が該当箇所を示していないため不承認",
      "evidence": "src/store.ts:10"
    }
  ],
  "conflictDecisions": [
    {
      "conflictId": "C-012345ABCDEF",
      "decision": "resolve",
      "evidence": "調停済みと判断した根拠"
    }
  ],
  "invalidateDecisions": [
    {
      "findingId": "F-0012",
      "evidence": "finding の location がレビュー対象コードのどのファイルとも対応しておらず、指摘の前提が成立しない"
    }
  ],
  "duplicateDecisions": [
    {
      "canonicalFindingId": "F-0011",
      "duplicateFindingIds": ["F-0017", "F-0018"],
      "evidence": "3件とも同じ分散ロックの cleanup 漏れを指しており、レビュアーが異なる familyTag・異なる行を引用しただけ"
    }
  ]
}
```

`rawDecisions` のルール。
- プロンプトに列挙された raw finding 1件につき、ちょうど1エントリを返してください（過不足禁止）。
- `findingId` は `same` / `resolved` / `reopened` / `conflict` のとき必須です。`new` と `unsupported` のときは空文字にしてください。
- `unsupported` は、raw finding が既存 finding を明示参照した（targetFindingId 設定済み）にもかかわらずその参照が成立しない場合に使います。finding は作られず、何も変更されません。
- 判断だけを返してください。最終結果の組み立て（対応づけ、グルーピング、conflict の形状）は自分で行わず、エンジンが組み立てと台帳の不変条件チェックを行います。
- familyTag と行番号の差はヒントに過ぎません。same か new かは failure mode・発生条件・影響・必要な修正で判断してください。

`disputeDecisions` と `conflictDecisions` のルール。
- 裁定対象が無い場合（直前ステップ応答に「Disputed Findings」見出しが無い、または台帳に active な conflict が無い）は両方とも空配列にしてください。

`invalidateDecisions` と `duplicateDecisions` のルール。
- `invalidateDecisions` はプロンプトが invalidate 候補として列挙した finding id のみが対象です（エンジンが location の決定的検証を既に済ませています）。候補が無い、またはすべてに同意しない場合は空配列にしてください。
- `duplicateDecisions` は同一の根本問題である open finding のためのものです。重複が見つからなければ空配列にしてください。
