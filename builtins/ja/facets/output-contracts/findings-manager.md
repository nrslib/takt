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
  ],
  "dismissDecisions": [
    {
      "findingId": "F-0021",
      "basis": "outside_task_scope",
      "reason": "主張は GitLab 添付を対象とするが、元の workflow task は GitHub 添付対応だけを要求している",
      "taskQuote": "GitHub issue の添付に対応する"
    }
  ]
}
```

`rawDecisions` のルール。
- プロンプトに列挙された raw finding 1件につき、ちょうど1エントリを返してください（過不足禁止）。
- 過去に resolved / waived / dismissed となった finding が再発した場合は `reopened` を使ってください。
- `findingId` は `same` / `resolved` / `reopened` / `conflict` のとき必須です。`new` と `unsupported` のときは空文字にしてください。
- `unsupported` は、raw finding が既存 finding を明示参照した（targetFindingId 設定済み）にもかかわらずその参照が成立しない場合に使います。confirmed finding は作らず対象 finding も変更しませんが、raw は gate-blocking provisional として保持されます。
- 判断だけを返してください。最終結果の組み立て（対応づけ、グルーピング、conflict の形状）は自分で行わず、エンジンが組み立てと台帳の不変条件チェックを行います。
- familyTag と行番号の差はヒントに過ぎません。same か new かは failure mode・発生条件・影響・必要な修正で判断してください。

`disputeDecisions` と `conflictDecisions` のルール。
- 裁定対象が無い場合（直前ステップ応答に「Disputed Findings」見出しが無い、または台帳に active な conflict が無い）は両方とも空配列にしてください。

`invalidateDecisions` と `duplicateDecisions` のルール。
- `invalidateDecisions` はプロンプトが invalidate 候補として列挙した finding id のみが対象です（エンジンが location の決定的検証を既に済ませています）。候補が無い、またはすべてに同意しない場合は空配列にしてください。
- `duplicateDecisions` は同一の根本問題である open finding のためのものです。重複が見つからなければ空配列にしてください。

`dismissDecisions` のルール。
- プロンプトが dismiss 候補として列挙した finding id（機械で確定できない open な暫定 finding）のみが対象です。リスト外への dismiss はエンジンが不採用にします。
- `basis` は通常 `outside_contract_jurisdiction` または `unverifiable_claim` です。エンジンが control task に `terminal_adjudication` を明示した場合だけ `outside_task_scope`、`false_positive`、`overreach`、`no_issue_after_verification` も選べます。
- `outside_task_scope` では、元の workflow task の非空 byte-exact substring を `taskQuote` に入れ、`reason` と分離します。この basis に自由文 `evidence` を返してはいけません。
- その他の basis の `evidence` には現在のコードを確認した具体的根拠を入れます。沈黙や再報告されなかったことだけでは不十分です。
- 懸念が実在しても元 task の範囲外なら `outside_task_scope` にできます。同一 task の後続観測は監査のみとし、別 task は独自の scope で評価します。
- エンジンによる decision rejection、stale findingId、unsupported、decision 欠落そのものは dismiss の根拠にしないでください。raw の内容を評価し、実在するコード上の懸念なら open のまま残してください。
- 候補が無い、またはすべて open のままにする場合は空配列にしてください。

解釈フェーズ（ambiguous な raw finding が存在するときの別呼び出し）:
- エンジンは「Ambiguous raw finding interpretation」プロンプトであなたを呼ぶことがあります。そこでは ambiguous raw finding 1件につき1つの「提案」を `interpretations` で返します: `create_independent`、`same_with_proof`（プロンプトでエンジンが発行した proofId がある場合のみ）、`open_conflict`、`provisional` のいずれかです。
- このフェーズから finding を resolve / waive / invalidate / supersede / reopen することは決してできません。付与された権限の外の提案は gate-blocking な provisional finding になります。
